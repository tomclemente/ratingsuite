var mysql = require('mysql');
var AWS = require('aws-sdk');

var pool = mysql.createPool({
    connectionLimit : 20,
    host     : process.env.RDS_ENDPOINT,
    user     : process.env.RDS_USERNAME,
    password : process.env.RDS_PASSWORD,
    database : process.env.RDS_DATABASE,
    debug    :  false
});    

var sql;
var userid;
var respObj = [];
var preferenceType = null;

//cognito information
var forg;
var fname;
var femail;

exports.handler = async (event, context) => {

    let params = JSON.parse(event["body"]);
    console.log('Received event:', JSON.stringify(event, null, 2));
    
    if (isEmpty(event.requestContext.authorizer.claims.username)) {
      userid = event.requestContext.authorizer.claims["cognito:username"];
    } else {
      userid = event.requestContext.authorizer.claims.username;
    }
    
    if (userid == null) {
        throw new Error("Username missing. Not authenticated.");
    }
    
    let body;
    let statusCode = '200';

    const headers = {
        'Content-Type': 'application/json',
        "Access-Control-Allow-Headers" : "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PUT,DELETE"
    };

    try {

        body = await new Promise((resolve, reject) => {

            getCognitoUser().then(function(data) {              
                console.log("Cognito UserAttributes: ", data.UserAttributes);
                for (var x = 0; x < data.UserAttributes.length; x++) {
                    let attrib = data.UserAttributes[x];

                    if (attrib.Name == 'custom:name') {
                        fname = attrib.Value;
                    } else if (attrib.Name == 'email') {
                        femail = attrib.Value;
                    } else if (attrib.Name == 'custom:Organization') {
                        forg = attrib.Value;
                    }
                }

            }).then(function() {
                switch (event.httpMethod) {

                    case 'POST':

                        if (isEmpty(params.upid) && isEmpty(params.upid)) { // FOR GET REQUEST

                            getUser().then(async function(data) {

                                if (!isEmpty(data) && 
                                    data[0]["userStatus"] != 'CUSTOMER' && 
                                    data[0]["userStatus"] != 'BETA') {
    
                                    throw new Error("Not authorized.");
                                }
    
                                if (!isEmpty(data)) {
                                    respObj = new Array();
                                    
                                    await getUserFilterPreference(params);
                                    await getUserChannelPreference(params);
                                    await getUserProductPreference(params);
                                    
                                    resolve(respObj);
                                }
    
                            }, reject).catch(err => {
                                reject({ statusCode: 500, body: err.message });
                            });

                        } else {

       
                            console.log("upid list: ", params.upid);
                            console.log("upcid list: ", params.upcid);

                            getUser().then(async function(data) {

                                if (!isEmpty(data) && 
                                    data[0]["userStatus"] != 'CUSTOMER' && 
                                    data[0]["userStatus"] != 'BETA') {

                                    throw new Error("Not authorized.");
                                }

                                if (!isEmpty(params.preferenceType)) {
                                    preferenceType = params.preferenceType;
                                } else {
                                    throw new Error("preferenceType is missing.");
                                }
                                
                                if (preferenceType != "REVIEW" && 
                                    preferenceType != "INSIGHT" && 
                                    preferenceType != "COMPARISON") {                                    
                                        throw new Error("Invalid Parameter.");
                                }

                                if (!isEmpty(preferenceType)) {
                                    await deleteUserFilterPreference();                        
                                    await deleteUserChannelPreference();                            
                                    await deleteUserProductPreference();
                                }                            

                                if (!isEmpty(params.filter)) {
                                    await insertUserFilterPreference(params);
                                } 
                                
                                let uppromises = [];
                                if (!isEmpty(params.upid)) {
                                    var upid = params.upid;
                                    upid.forEach(function(entry) {
                                        console.log("insertUserProductPreference upid: ", entry);
                                        uppromises.push(insertUserProductPreference(entry));
                                    });

                                    await Promise.all(uppromises).catch(err => {
                                        reject({ statusCode: 500, body: err.message });
                                    });    
                                }                

                                let ucpromises = [];
                                if (!isEmpty(params.upcid)) {
                                    var upcid = params.upcid;
                                    upcid.forEach(function(entry) {
                                        console.log("insertUserChannelPreference upcid: ", entry);
                                        ucpromises.push(insertUserChannelPreference(entry));
                                    });

                                    await Promise.all(ucpromises).catch(err => {
                                        reject({ statusCode: 500, body: err.message });
                                    });  
                                }
                    
                            }, reject).then(function() {
                                resolve(params);
                            }).catch(err => {
                                reject({ statusCode: 500, body: err.message });
                            });
                        }                  

                    break;
                        
                    case 'DELETE':

                        getUser().then(async function(data) {

                            if (!isEmpty(data) && 
                                data[0]["userStatus"] != 'CUSTOMER' && 
                                data[0]["userStatus"] != 'BETA') {

                                throw new Error("Not authorized.");
                            }

                            if (!isEmpty(params.preferenceType)) {
                                preferenceType = params.preferenceType;
                            } else {
                                throw new Error("preferenceType is missing.");
                            }

                            if (preferenceType != "REVIEW" && 
                                preferenceType != "INSIGHT" && 
                                preferenceType != "COMPARISON") {                                    
                                    throw new Error("Invalid Parameter.");
                            }

                            if (!isEmpty(preferenceType)) {
                                await deleteUserFilterPreference();                        
                                await deleteUserChannelPreference();                            
                                await deleteUserProductPreference();
                            }       

                        }, reject).then(function() {
                            resolve(params);
                        }).catch(err => {
                            reject({ statusCode: 500, body: err.message });
                        }); 

                    break;


                    default:
                        throw new Error(`Unsupported method "${event.httpMethod}"`);
                }    
            }, reject);
        });

    } catch (err) {
        statusCode = '400';
        body = err;
        console.log("body return 1", err);
        
    } finally {
        body = JSON.stringify(body);
    }

    return {
        statusCode,
        body,
        headers,
    };
};

function isEmpty(data) {
    if (data == undefined || data == null || data.length == 0) {
        return true;
    }
    return false;
}

function executeQuery(sql) {
    return new Promise((resolve, reject) => {

        pool.getConnection((err, connection) => {
            if (err) {
                console.log("executeQuery error: ", err);
                reject(err);
                return;
            }

            connection.query(sql, function(err, result) {
                connection.release();
                if (!err) {
                    console.log("Executed query: ", sql);
                    console.log("SQL Result: ", result[0] == undefined ? result : result[0]);
                    resolve(result);
                } else {
                    reject(err);
                }               
            });
        });
    });
};

function executePostQuery(sql, post) {
    return new Promise((resolve, reject) => {                
        pool.getConnection((err, connection) => {
            if (err) {
                console.log("executePostQuery error: ", err);
                reject(err);
                return;
            }

            connection.query(sql, post, function (err, result) {
                connection.release();
                if (!err) {
                    console.log("Executed post query: ", sql + " " + JSON.stringify(post));
                    console.log("SQL Result: ", result);
                    resolve(result.affectedRows);
                } else {
                    reject(err);
                }
            });
        }); 
    });
};

function getCognitoUser() {
    const cognito = new AWS.CognitoIdentityServiceProvider({ region: process.env.REGION });

    return cognito.adminGetUser({
        UserPoolId: process.env.COGNITO_POOLID,
        Username: userid, 
        
    }).promise();
}

function getUser() {
    sql = "SELECT userStatus from UserMaster WHERE userid = '" + userid + "'";
    return executeQuery(sql);
}

function getUserFilterPreference(params) {
    sql = "SELECT * FROM UserFilterPreference \
            WHERE userid = '" + userid + "' \
            AND preferenceType  = '" + params.preferenceType + "'";

    return executeQuery(sql).then(function(result) {
        respObj.push(result);
        console.log("getUserFilterPreference: ", result);
        console.log("respObj: ", respObj);
    });
}

function getUserChannelPreference(params) {
    sql = "SELECT upcid from UserChannelPreference \
            WHERE userid = '" + userid + "' \
            AND preferenceType  = '" + params.preferenceType + "'";

    return executeQuery(sql).then(function(result) {
        respObj.push(result);
        console.log("getUserChannelPreference: ", result);
        console.log("respObj: ", respObj);
    });
}

function getUserProductPreference(params) {
    sql = "SELECT upid from UserProductPreference \
            WHERE userid = '" + userid + "' \
            AND preferenceType  = '" + params.preferenceType + "'";

    return executeQuery(sql).then(function(result) {
        respObj.push(result);
        console.log("getUserProductPreference: ", result);
        console.log("respObj: ", respObj);
    });
}

function deleteUserFilterPreference() {
    sql = "DELETE from UserFilterPreference  \
            WHERE userid = '" + userid + "' \
            AND preferenceType  = '" + preferenceType + "'";
    return executeQuery(sql);
}

function deleteUserChannelPreference() {
    sql = "DELETE from UserChannelPreference  \
            WHERE userid = '" + userid + "' \
            AND preferenceType  = '" + preferenceType + "'";
    return executeQuery(sql);
}

function deleteUserProductPreference() {
    sql = "DELETE from UserProductPreference  \
            WHERE userid = '" + userid + "' \
            AND preferenceType  = '" + preferenceType + "'";
    return executeQuery(sql);
}

function insertUserFilterPreference(params) {
    var post = {preferenceType: params.preferenceType, 
                time: params.time, timeFrom: params.timeFrom, 
                timeTo: params.timeTo, rating: params.rating,
                sentiment: params.sentiment, sort: params.sort };
    sql = "INSERT INTO UserFilterPreference SET ?";
    return executePostQuery(sql, post); 
}

function insertUserProductPreference(upid) {
    var post = {userid: userid, upid: upid, preferenceType: preferenceType};
    sql = "INSERT INTO UserProductPreference SET ?";
    return executePostQuery(sql, post);   
}

function insertUserChannelPreference(upcid) {
    var post = {userid: userid, upcid: upcid, preferenceType: preferenceType};
    sql = "INSERT INTO UserChannelPreference SET ?";
    return executePostQuery(sql, post); 
}
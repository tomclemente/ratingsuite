'use strict';

var mysql = require('mysql');
var AWS = require('aws-sdk');

var sourceEmail = process.env.SOURCE_EMAIL;
var supportEmail = process.env.SUPPORT_EMAIL;

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
var g_idUserPool = null;
var arrPromise = [];
var userMasterData = null;
var notificationData = null;
var subscriptionData = null;
var recentUserProduct = null;

//cognito information
var forg;
var fname;
var femail;

exports.handler = async (event, context) => {

    let params = JSON.parse(event["body"]);
    console.log('Received event:', JSON.stringify(event, null, 2));
    
    userid = event.requestContext.authorizer.claims.username;
    if (userid == null) {
        throw new Error("Username missing. Not authenticated.");
    }
    
    let body;
    let statusCode = '200';

    const headers = {
        'Content-Type': 'application/json',
        "Access-Control-Allow-Headers" : "Content-Type",
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

                    case 'GET':
                        getIdPool().then(function(result) {
                            if (!isEmpty(result)) {
                                getSubscriptionDetails().then(function(data) {
                                    resolve(data);
                                }, reject);
                            }
                        }, reject).catch(err => {
                            reject({ statusCode: 500, body: err.message });
                        });
                    break;
    
                    case 'POST':
                        var idPool;

                        arrPromise.push(getNotification());
                        arrPromise.push(getUserMaster());

                        Promise.all(arrPromise).then(function() {
                            if (params.plan == 'Sandbox') {
                                if (userMasterData.userStatus != 'NEW') {
                                    throw new Error("Not authorized.");

                                } else {                                    
                                    getSandboxIdUserPool().then(async function(data) {
                                        if (isEmpty(data)) {
                                            throw new Error("Missing UserPool data.");
                                            
                                        } else {
                                            params.idUserPool = data[0].idUserPool;
                                            await insertUserPoolPOST(params.idUserPool);
                                            await updateUserBeta();
                                        }

                                    }, reject).then(function() {
                                        if (!isEmpty(notificationData)) {
                                            return sendEmail(generateSandboxEmail());
                                        }

                                    }, reject).then(function() {
                                        console.log("Returning Params: ", params);
                                        resolve(params);

                                    }).catch(err => reject({ statusCode: 500, body: err.message }));
                                }
                            }
    
                            if (isEmpty(params.plan)) {
                                if (userMasterData.userStatus == 'E') {
                                    throw new Error("Not authorized.");
                                }

                                getUserPoolTypePOST().then(async function(data) {
                                    if (!isEmpty(data) && data[0].type == "USER") {
                                        throw new Error("Not authorized.");
    
                                    } else if (isEmpty(data)) {
                                        await addAdminToUserPoolPOST();
                                        await updateUserMasterPOST();
                                        const res = await getNewIdUserPoolPOST();
                                        idPool = res[0].idUserPool;    

                                    } else if (!isEmpty(data)) {
                                        idPool = data[0].idUserPool
                                    }
                                    
                                }).then(function() {
                                    if (isEmpty(params.upid)) { //New Product
                                        return createNewProductPOST(params);
                                    } else { //New Channel
                                        return createUserProductChannelPOST(params.upid, params);
                                    }

                                }).then(async function() {
                                    if (isEmpty(params.upid)) {
                                        const result = await getUpIDPOST();
                                        params.upid = result[0].upid;
                                        return createUserProductChannelPOST(params.upid, params).then(function() {
                                            return createSubscriptionPOST(params.upid, idPool);
                                        });
                                    }

                                }).then(function() {
                                    return sendEmail(generatePOSTEmail(params));
    
                                }).then(function() {
                                    console.log("Returning Params: ", params);
                                    resolve(params);
                                        
                                }).catch(err => reject({ statusCode: 500, body: err.message }));
                            }
                        }, reject).catch(err => reject({ statusCode: 500, body: err.message }));

                    break;
                        
                    case 'PUT':
                        if (params.plan == 'Sandbox') {
                            throw new Error("Not authorized.");
                            
                        } else {
                            getUserMasterPUT().then(async function(result) {
                                if (isEmpty(result)) {
                                    throw new Error("Not authorized.");                                
                                    
                                } else {
                                    let type = result[0].type;

                                    if (type == 'USER') {
                                        throw new Error("Not authorized.");    

                                    } else if (type == 'ADMIN') {
                                        g_idUserPool = result[0].idUserPool;
                                        
                                        if (params.updateType == 'Product') {
                                            if (!isEmpty(params.productAlias) && !isEmpty(params.upid)) {
                                                await updateUserProductPUT(params.productAlias, params.upid);
                                            }

                                        } else if (params.updateType == 'Channel') {
                                            await updateUserProductChannelPUT(params.channelName, params.channelURL, params.upcid);
                                            await updateProductChannelPUT(params.upcid);

                                        } else {
                                            throw new Error("Missing updateType.");
                                        }

                                    } else {
                                        throw new Error("Invalid User Type.");
                                    }
                                }
                                
                            }, reject).then(function() {
                                return sendEmail(generateUpdateEmail(params.upid, params.upcid));

                            }, reject).then(function() {
                                resolve(params);
    
                            }, reject).catch(err => reject({ statusCode: 500, body: err.message }));  
                        }
                    break;
                    
                    case 'DELETE': 
                    
                        arrPromise.push(getUserMaster());
                        arrPromise.push(getNotification());
                        
                        Promise.all(arrPromise).then(async function() {
                            if (userMasterData.userType == 'E') {
                                throw new Error("Not authorized.");                            
                            }
                            
                            if (params.plan == 'Sandbox') {
                                try {

                                    const result = await getSandboxIdUserPool();
                                    if (!isEmpty(result)) {
                                        g_idUserPool = result[0].idUserPool;

                                        if (!isEmpty(g_idUserPool)) {
                                            await deleteFromUserPool(g_idUserPool);
                                            if (!isEmpty(params.upid)) {
                                                await getSubscription(params.upid, g_idUserPool);
                                            }
                                        }
                                    } 

                                } catch (err) {
                                    return reject({ statusCode: 500, body: err.message });
                                }
                                
                            } else {

                                return getAdminIdUserPool().then(async function(result) {                                                         
                                    if (isEmpty(result)) {
                                        throw new Error("Not authorized.");
                                        
                                    } else {
                                        g_idUserPool = result[0].idUserPool;

                                        await getSubscription(params.upid, g_idUserPool);

                                        if (isEmpty(subscriptionData)) {
                                            throw new Error("No subscription found");

                                        } else {

                                            if (isEmpty(params.updateType)) {
                                                throw new Error("updateType is missing.");    
                                            }
                                        
                                            if (params.updateType == 'Product' && isEmpty(params.upid)) {
                                                throw new Error("upid is missing.");

                                            } else if (params.updateType == 'Channel' && isEmpty(params.upcid)) {
                                                throw new Error("upcid is missing.");
                                            }

                                            if (params.updateType == 'Product') {
                                                await cancelSubscription(g_idUserPool, params.upid);

                                            } else if (params.updateType == 'Channel') {
                                                await decreaseActiveUsersFromProductChannel(params.upcid);
                                                await setInactiveProductChannel(params.upcid);
                                                await deleteUserProductChannel(params.upcid);
                                            }
                                        }
                                    }
                                }).catch(err => reject({ statusCode: 500, body: err.message }));
                            }          
                                                                      
                        }, reject).then(function() {
                            if (params.updateType == 'Product' 
                                    && (!isEmpty(subscriptionData) 
                                    && subscriptionData.subscriptionStatus == 'ACTIVE')
                                    && !isEmpty(notificationData)) {
                                        return sendEmail(generateCancelEmail());
                            } 
                            
                        }).then(function() {
                            resolve(params);

                        }, reject).catch(err => reject({ statusCode: 500, body: err.message }));
                        
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

//COMMON FUNCTIONS

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

            // connection.on('error', function(err) {
            //     console.log("connection.on ", err);
            //     reject(err);
            //     return;
            // });
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

            // connection.on('error', function (err) {
            //     console.log("connection.on ", err);
            //     reject(err);
            //     return;
            // });
        }); 
    });
};

function sendEmail(params) {
    return new Promise((resolve, reject) => {
        var ses = new AWS.SES({region: 'us-east-1'});
        console.log("Sending Email: ", params);
        ses.sendEmail(params, function (err, data) {
            if (err) {
                console.log("Email Error: ", err);
                reject(err);
            } else {
                console.log("Email Success: ", data);
                resolve(data);
            }
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

function getNotification() {
    sql = "SELECT * FROM Notification where flag = 1 and notificationTypeID = 1 and userid = '" + userid + "'";
    return executeQuery(sql).then(function(result) {
        notificationData = result[0];
        console.log("notificationData: ", notificationData);
    }); 
}

//DELETE FUNCTIONS

function getUserMaster() {
    sql = "SELECT * FROM UserMaster where userid = '" + userid + "'";
    return executeQuery(sql).then(function(result) {
        userMasterData = result[0];
        console.log("UserMasterData: ", userMasterData);
    });
}

function getSandboxIdUserPool() {
    console.log("getSandboxIdUserPool()");
    sql = "SELECT up.idUserPool, s.idProductPlan \
            FROM UserPool up \
            JOIN Subscription s ON (s.idUserPool = up.idUserPool) \
            WHERE up.type = 'ADMIN' \
            AND s.idProductPlan = 'PP1' \
            AND s.subscriptionStatus = 'ACTIVE' ";                    
    return executeQuery(sql);
}

function deleteFromUserPool(idUserPool) {
    sql = "DELETE FROM UserPool \
            WHERE idUserPool = '" + idUserPool + "' \
            AND userid = '" + userid + "'";
    return executeQuery(sql);
}

function getAdminIdUserPool() {    
        sql = "SELECT up.idUserPool \
            FROM UserPool up \
            JOIN UserMaster um ON (up.userid = um.userid) \
            WHERE um.userid = '" + userid + "' AND up.type = 'ADMIN' AND up.idUserPool not in \
            ( SELECT DISTINCT (up2.idUserPool) FROM UserPool up2 \
            JOIN Subscription s ON (s.idUserPool = up2.idUserPool) \
            WHERE up2.type = 'ADMIN' AND s.idProductPlan = 'PP1' AND s.subscriptionStatus = 'ACTIVE')" ;

    return executeQuery(sql);
}

function getSubscription(upid, idUserPool) {    
    sql = "SELECT * \
            FROM Subscription \
            WHERE upid = '" + upid + "' \
            AND idUserPool = '" + idUserPool + "'";
    return executeQuery(sql).then(function(result) {
        subscriptionData = result[0];
        console.log("subscriptionData: ", subscriptionData);
    });  
}


function cancelSubscription(idUserPool, upid) {
    sql = "UPDATE Subscription \
            SET cancelledOn = CURRENT_DATE() \
            WHERE idUserPool = '" + idUserPool + "' \
            AND upid = '" + upid + "'";
    return executeQuery(sql);
}

function decreaseActiveUsersFromProductChannel(upcid) {
    sql = "UPDATE ProductChannel \
            SET nActiveUsers = nActiveUsers - 1 \
            WHERE pcid = (SELECT pcid FROM ProductChannelMapping \
                            WHERE upcid = '" + upcid + "')";
    return executeQuery(sql);
}

function setInactiveProductChannel(upcid) {
    sql = "UPDATE ProductChannel \
            SET status = 'INACTIVE' \
            WHERE nActiveusers = 0 and pcid = (SELECT pcid FROM ProductChannelMapping \
                            WHERE upcid = '" + upcid + "')";
    return executeQuery(sql);
}

function deleteUserProductChannel(upcid) {
    sql = "DELETE FROM UserProductChannel \
            WHERE upcid = '" + upcid + "'" ;
    return executeQuery(sql);
}

function generateCancelEmail() {
    var param = {
        Destination: {
            ToAddresses: [femail]
        },
        Message: {
            Body: {
                Text: { Data: "A product has been deleted."

                }
            },
            Subject: { Data: "Product Deletion" }
        },
        Source: sourceEmail
    };

    return param;
}

//GET FUNCTIONS

function getIdPool() {
    sql = "SELECT idUserPool \
            FROM UserPool \
            WHERE userid = '" + userid + "'" ;
    return executeQuery(sql);
}

function getSubscriptionDetails() {
    sql = "SELECT pp.plan, s.startDt, s.endDt, s.subscriptionStatus, upl.idUserPool, upl.type, s.upid, \
            up.productAlias, upc.upcid, upc.channelName, upc.upcURL \
             FROM UserProductChannel upc \
             JOIN UserProduct up ON (upc.upid = up.upid) \
             JOIN Subscription s ON (up.upid = s.upid) \
             JOIN ProductPlan pp ON (pp.idProductPlan = s.idProductPlan) \
             JOIN UserPool upl ON (upl.idUserPool = s.idUserPool) \
             WHERE upl.userid = '" + userid + "'" ;
    return executeQuery(sql);    
}

//PUT FUNCTIONS

function getUserMasterPUT() {
    sql = "SELECT up.type, up.idUserPool \
            FROM UserPool up \
            JOIN UserMaster um ON (up.userid = um.userid) \
             WHERE um.userid = '" + userid + "' AND up.idUserPool not in \
             ( SELECT DISTINCT (up2.idUserPool) FROM UserPool up2 \
             JOIN Subscription s ON (s.idUserPool = up2.idUserPool) \
             WHERE up2.type = 'ADMIN' AND s.idProductPlan = 'PP1' AND s.subscriptionStatus = 'ACTIVE')" ;
           
    return executeQuery(sql);;
}

function updateUserProductPUT(alias, upid) {
    sql = "UPDATE UserProduct \
            SET productAlias = '" + alias + "' \
            WHERE upid = '" + upid + "' ";
    return executeQuery(sql);;
}

function updateUserProductChannelPUT(channelname, channelURL, upcid) {
    sql = "UPDATE UserProductChannel \
            SET channelname = '" + channelname + "', \
                upcURL = '" + channelURL + "', \
                status = 'NEW' \
            WHERE upcid = '" + upcid + "' ";
    return executeQuery(sql);
}

function updateProductChannelPUT(upcid) {
    sql = "UPDATE ProductChannel \
            SET status = 'REVIEW' \
            WHERE pcid = (SELECT pcid FROM \
                        ProductChannelMapping \
                        WHERE upcid = '" + upcid + "') ";
    return executeQuery(sql);    
}

function generateUpdateEmail(upid, upcid) {
    var param = {
        Destination: {
            ToAddresses: [supportEmail]
        },
        Message: {
            Body: {
                Text: { Data: "A product has been updated."

                }
            },
            Subject: { Data: "Subscription update: \
                        upid: '" + upid + "' \
                        upcid: '" + upcid + "'" }
        },
        Source: sourceEmail
    };

    return param;
}

//POST FUNCTIONS

function getUserPoolTypePOST() {
    sql = "SELECT up.type, up.idUserPool \
             FROM UserPool up \
             JOIN UserMaster um ON (up.userid = um.userid) \
             WHERE um.userid = '" + userid + "' AND up.idUserPool not in \
             ( SELECT DISTINCT (up2.idUserPool) FROM UserPool up2 \
             JOIN Subscription s ON (s.idUserPool = up2.idUserPool) \
             WHERE up2.type = 'ADMIN' AND s.idProductPlan = 'PP1' AND s.subscriptionStatus = 'ACTIVE')" ;
    return executeQuery(sql);    
}

function addAdminToUserPoolPOST() {
    var post = {type: 'ADMIN', userid: userid};
    sql = "INSERT INTO UserPool SET ?";
    return executePostQuery(sql, post);
}

function updateUserMasterPOST() {
    console.log("updateUserMasterPOST()");
    sql = "UPDATE UserMaster \
        SET userStatus = 'PROSPECT' \
        WHERE userid = '" + userid + "'";
    return executeQuery(sql);
}

function getNewIdUserPoolPOST() {
    console.log("getNewIdUserPoolPOST()");
    sql = "SELECT idUserPool \
             FROM UserPool  \
             WHERE type = 'ADMIN' \
             AND userid = '" + userid + "'" ;
    return executeQuery(sql);    
}

function createNewProductPOST(params) {
    var post = {status: 'NEW', productAlias: params.productAlias};
    sql = "INSERT INTO UserProduct SET ?";
    return executePostQuery(sql, post);
}

function getUpIDPOST() {
    sql = "SELECT MAX(upid) as upid FROM UserProduct";            
    return executeQuery(sql);
}

function createUserProductChannelPOST(upid, params) {
    var post = {upid: upid, status: 'NEW', channelName: params.channelName, upcURL: params.channelURL};
    sql = "INSERT INTO UserProductChannel SET ?";
    return executePostQuery(sql, post); 
}

function createSubscriptionPOST(upid, idUserPool) {
    var post = {idProductPlan: 'PP5', upid: upid, idUserPool: idUserPool, subscriptionStatus: 'NEW'};
    sql = "INSERT INTO Subscription SET ?";
    return executePostQuery(sql, post);   
}

function insertUserPoolPOST(idUserPool) {
    var post = {idUserPool: idUserPool, type: 'USER', userid: userid};
    sql = "INSERT INTO UserPool SET ?";
    return executePostQuery(sql, post);   
}

function updateUserBeta() {
    sql = "UPDATE UserMaster \
            SET userStatus = 'BETA' \
            WHERE userid = '" + userid + "'";
    return executeQuery(sql);
}

function generatePOSTEmail(params) {

    if (isEmpty(params.upid)) params.upid = '';
    if (isEmpty(params.upcid)) params.upcid = '';
    if (isEmpty(params.channelURL)) params.channelURL = '';
    if (isEmpty(params.channelName)) params.channelName = '';
    if (isEmpty(params.productAlias)) params.productAlias = '';

    var param = {
        Destination: {
            ToAddresses: [supportEmail]
        },
        Message: {
            Body: {
                Text: { Data: "A new subscription has been updated."

                }
            },
            Subject: { Data: "New subscription: \
                        upid: '" + params.upid + "' \
                        productAlias: '" + params.productAlias + "' \
                        upcid: '" + params.upcid + "' \
                        channelName: '" + params.channelName + "' \
                        channelURL: '" + params.channelURL + "' " }
        },
        Source: sourceEmail
    };

    console.log("generatePOSTEmail: ", param);

    return param;
}

function generateSandboxEmail() {

    var param = {
        Destination: {
            ToAddresses: [femail]
        },
        Message: {
            Body: {
                Text: { Data: "Your sandbox subscription is now active."

                }
            },
            Subject: { Data: "Sandbox subscription." }
        },
        Source: sourceEmail
    };

    return param;
}

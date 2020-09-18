var mysql = require('mysql');
var AWS = require('aws-sdk');

var sourceEmail = process.env.SOURCE_EMAIL;

var connection = mysql.createConnection({
    host: process.env.RDS_ENDPOINT,
    user: process.env.RDS_USERNAME,
    password: process.env.RDS_PASSWORD,
    database: process.env.RDS_DATABASE
});

var sql;
var userid;

var userPoolData;
var userMasterData;
var subscriptionData;
var notificationData;
var UPIDdata = [];
var deletePromises = [];

//cognito information
var forg;
var fname;
var femail;

exports.handler = async (event, context) => {

    let params = JSON.parse(event["body"]);
    console.log('Received event:', JSON.stringify(event, null, 2));

    userid = event.requestContext.authorizer.claims.username;
    if (userid == null) {
        throw new Error("Username is missing. Not authenticated.");
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
                        sql = "SELECT um.userid, um.name, um.userType, um.organization, um.userStatus, nt.desc,n.flag \
                                FROM UserMaster um \
                                LEFT OUTER JOIN Notification n on um.userid = n.userid and n.notificationTypeID = 1 \
                                LEFT OUTER JOIN NotificationType nt on n.notificationTypeID = nt.notificationTypeID \
                                WHERE um.userid = '" + userid + "'";
                        executeQuery(sql).then(resolve, reject);
                    break;
    
                    case 'POST': 

                        insertUserMaster(fname, forg).then(function() {
                            insertNotification().then(resolve, reject);                        
                            var emailParam = generateWelcomeParam();
                            sendEmail(emailParam).then(resolve, reject);
                        }, reject);

                    break;
                        
                    case 'PUT':
                        updateUserAttribute(params, userid).then(function() {
                            sql = "UPDATE UserMaster \
                                    SET organization = '" + params.organization + "', \
                                    name = '" + params.name + "' \
                                    WHERE userid = '" + userid + "'";
                            executeQuery(sql).then(resolve, reject);  
                        }, reject);
                    break;
                    
                    case 'DELETE': 
                        deletePromises.push(getUserMaster());
                        deletePromises.push(getUserPool());
                        deletePromises.push(getNotification());
                        deletePromises.push(getAllUPID());

                        Promise.all(deletePromises).then(function() {
                            if (userPoolData != undefined && userPoolData.idUserPool != undefined) {
                                getSubscription(userPoolData.idUserPool).then(function() {
                                    if (( subscriptionData != undefined) ||
                                        (userMasterData.usertype != 'E')) {
                                        
                                        updateCancelledSubscription(userPoolData.idUserPool).then(resolve,reject);
                                    }
                                }, resolve);
                            }

                        }, reject).then(function() { //delete all associated pcid and upid
                            if (UPIDdata != undefined) {
                                for (var x = 0; x < UPIDdata.length; x++) {

                                    getAllPCID(UPIDdata[x].upid).then(function(data) {
                                        if (data != undefined) {
                                            
                                            for (var y = 0; y < data.length; y++) {

                                            let pcid = data[y].pcid;
                                            unsubscribeProductChannel(pcid).then(resolve, reject);
                                            updateProductChannel(pcid).then(resolve, reject);
                                            
                                            }
                                        }
                                    
                                    }, reject);

                                    deleteUserProduct(UPIDdata[x].upid).then(resolve, reject);
                                }
                            } 

                        }, reject).then(function() { 
                            deleteUserMaster().then(function() {
                                deleteCognitoUser().then(function() {
                                        var emailParam = generateGoodbyeParam();
                                        sendEmail(emailParam).then(resolve, reject);
                                          
                                }, reject);
                            }, reject);
                        }, reject);   
                        
                    break;
                        
                    default:
                        throw new Error(`Unsupported method "${event.httpMethod}"`);
                }    
            }, reject);
        });

    } catch (err) {
        statusCode = '400';
        body = err.message;
    } finally {
        body = JSON.stringify(body);
    }

    return {
        statusCode,
        body,
        headers,
    };
};

function getAllUPID() {
    sql = "SELECT s.upid FROM Subscription s \
            JOIN UserPool up ON (s.idUserPool = up.idUserPool) \
            WHERE up.type = 'ADMIN' and up.userid = '" + userid + "'";                    
    return executeQuery(sql).then(function(result) {
        UPIDdata = result;
        console.log("UPIDdata: ", UPIDdata);
    });
}

function getAllPCID(upid) {
    sql = "SELECT pcid FROM ProductChannelMapping \
            WHERE upcid IN (SELECT upcid FROM UserProductChannel WHERE upid = '" + upid + "')";
    return executeQuery(sql);
}

function unsubscribeProductChannel(pcid) {
    sql = "UPDATE ProductChannel \
            SET nActiveUsers = nActiveUsers - 1 \
            WHERE pcid  = '" + pcid + "'";
    return executeQuery(sql);  
}

function updateProductChannel(pcid) {
    sql = "UPDATE ProductChannel \
            SET status = 'INACTIVE' \
            WHERE nActiveUsers = 0 and pcid  = '" + pcid + "'";
    return executeQuery(sql);  
}

function deleteUserMaster() {
    sql = "DELETE FROM UserMaster where userid = '" + userid + "'";
    return executeQuery(sql);
}

function getUserMaster() {
    sql = "SELECT * FROM UserMaster where userid = '" + userid + "'";                    
    return executeQuery(sql).then(function(result) {
        userMasterData = result[0];
        console.log("UserMasterData: ", userMasterData);
    });
}

function getUserPool() {
    sql = "SELECT * FROM UserPool where type = 'ADMIN' and userid = '" + userid + "'";
    return executeQuery(sql).then(function(result) {
        userPoolData = result[0];
        console.log("userPoolData: ", userPoolData);
    });
}

function getSubscription(idUserPool) {    
    sql = "SELECT * FROM Subscription where idUserPool = '" + idUserPool + "'";
    return executeQuery(sql).then(function(result) {
        subscriptionData = result[0];
        console.log("subscriptionData: ", subscriptionData);
    });
}

function getNotification() {
    sql = "SELECT * FROM Notification where userid = '" + userid + "'";
    return executeQuery(sql).then(function(result) {
        notificationData = result[0];
        console.log("notificationData: ", notificationData);
    });
}

function updateCancelledSubscription(idUserPool) {    
    sql = "UPDATE Subscription SET subscriptionStatus = 'CANCELLED' where idUserPool = '" + idUserPool + "'";
    return executeQuery(sql);
}

function getCognitoUser() {
    const cognito = new AWS.CognitoIdentityServiceProvider({ region: process.env.REGION });

    return cognito.adminGetUser({
        UserPoolId: process.env.COGNITO_POOLID,
        Username: userid, 
        
    }).promise();
}

function deleteCognitoUser() {
    const cognito = new AWS.CognitoIdentityServiceProvider({ region: process.env.REGION });
    return cognito.adminDeleteUser({
        UserPoolId: process.env.COGNITO_POOLID,
        Username: userid,
    }).promise();
}

function deleteUserProduct(id) {
    sql = "DELETE FROM UserProduct  where upid = '" + id + "'";
    return executeQuery(sql);
}

function executeQuery(sql) {
    return new Promise((resolve, reject) => {
        console.log("Executing query: ", sql);
        connection.query(sql, function(err, result) {
            if (err) {
                console.log("SQL Error: " + err);
                reject(err);
            }
            resolve(result);
        });
    });
};

function updateUserAttribute(params, userid){
    let cognitoISP = new AWS.CognitoIdentityServiceProvider({ region: process.env.REGION });
    return new Promise((resolve, reject) => {
        console.log("params: ", params);
        let attrib = {
            UserAttributes: [{
                    Name: "custom:name",
                    Value: params.name 
            },
            {
                    Name: "custom:Organization",
                    Value: params.organization
            }],
            UserPoolId: process.env.COGNITO_POOLID,
            Username: userid
        };

        cognitoISP.adminUpdateUserAttributes(attrib, (err, data) => err ? 
        reject(err) : resolve(data));
    });
};

function insertUserMaster(name, org) {
    sql = "INSERT INTO UserMaster (userid, name, userStatus, userType, organization) \
        VALUES (\
            '" + userid + "',\
            '" + name + "',\
            'NEW',\
            'NE',\
            '" + org + "')";
            
    return executeQuery(sql);
};

function insertNotification() {
    sql = "INSERT INTO Notification (userid, notificationTypeID, flag) \
        VALUES (\
            '" + userid + "',\
            '1',\
            '1')";
    return executeQuery(sql);
};

function sendEmail(params) {
    return new Promise((resolve, reject) => {
        var ses = new AWS.SES({region: 'us-east-1'});
        ses.sendEmail(params, function (err, data) {
            if (err) {
                console.log(err);
                reject(err);
            } else {
                console.log(data);
                resolve(data);
            }
        });
    });
};

function generateWelcomeParam() {
    var param = {
        Destination: {
            ToAddresses: [userid]
        },
        Message: {
            Body: {
                Text: { Data: "Welcome to RatingSuite!"

                }
            },
            Subject: { Data: "Welcome Email" }
        },
        Source: sourceEmail
    };

    return param;
}

function generateGoodbyeParam() {
    var param = {
        Destination: {
            ToAddresses: [userid]
        },
        Message: {
            Body: {
                Text: { Data: "Sad to see you go!"

                }
            },
            Subject: { Data: "Bye Email" }
        },
        Source: sourceEmail
    };

    return param;
}

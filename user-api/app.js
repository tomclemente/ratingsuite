var mysql = require('mysql');
var AWS = require('aws-sdk');

var sourceEmail = "noreply@ratingsuite.com";

var connection = mysql.createConnection({
    host: process.env.RDS_ENDPOINT,
    user: process.env.RDS_USERNAME,
    password: process.env.RDS_PASSWORD,
    database: process.env.RDS_DATABASE
});

var sql;
var userid;
var username;
var deletePromises = [];
var userPoolData;
var userMasterData;
var subscriptionData;
var notificationData;
var userProductChannelData;
var activeSubscriptionData;
var productChannelMappingData;

var UPIDdata = [];


var org;
var name;
var email;


exports.handler = async (event, context) => {

    username = event.requestContext.authorizer.claims.username;
    userid = event.requestContext.authorizer.claims.username;
    
    let params = JSON.parse(event["body"]);
    
    console.log('Received event:', JSON.stringify(event, null, 2));
    
    if (username == null) {
        throw new Error("Username missing. Not authenticated.");
    }
    
    let body;
    let statusCode = '200';

    const headers = {
        'Content-Type': 'application/json',
    };

    try {
        
        body = await new Promise((resolve, reject) => {

            switch (event.httpMethod) {

                case 'GET':
                    sql = "SELECT um.userid, um.name, um.userType, um.organization, um.userStatus, up.type, n.flag \
                            FROM UserMaster um \
                            INNER JOIN UserPool up on um.userid = up.userid \
                            INNER JOIN Notification n on um.userid = n.userid and n.notificationTypeID = 1 \
                            WHERE um.userid = '" + userid + "'";
                    executeQuery(sql).then(resolve, reject);
                break;

                case 'POST': 
                    getCognitoUser().then(function() {
                        insertUserMaster(name, org).then(function() {
                            insertNotification();                        
                            var emailParam = generateWelcomeParam();
                            sendEmail(emailParam).then(resolve,reject);
                        });
                    });
                break;
                    
                case 'PUT':
                    updateUserAttribute(params, userid).then(function() {
                        sql = "UPDATE UserMaster \
                                SET organization = '" + params.organization + "', \
                                name = '" + params.name + "' \
                                WHERE userid = '" + username + "'";
                        executeQuery(sql).then(resolve, reject);  
                    }, reject);
                break;
                
                case 'DELETE': 
                    deletePromises.push(getUserMaster());
                    deletePromises.push(getUserPool());
                    deletePromises.push(getNotification());
                    deletePromises.push(getAllUPID());
                    deletePromises.push(getCognitoUser());
                   
                    Promise.all(deletePromises).then(function() {
                        if (userPoolData != undefined && userPoolData.idUserPool != undefined) {
                            getSubscription(userPoolData.idUserPool).then(function() {
                                if ((userPoolData.type == 'user' && 
                                    subscriptionData != undefined && subscriptionData.subscriptionType =='pp1') ||
                                    (userPoolData.type == 'admin' && userMasterData.usertype != 'E')) {
                                    
                                    updateCancelledSubscription(userPoolData.idUserPool).then(resolve,reject);
                                }
                            });
                        }
                    }).then(function() { //delete all associated pcid and upid
                        if (UPIDdata != undefined) {
                            for (var x = 0; x < UPIDdata.length; x++) {
                                getAllPCID(UPIDdata[x]).then(function(data) {
                                    if (data != undefined) {
                                        unsubscribeProductChannel(data.upid);
                                        deleteUserProduct(data.upid);
                                    }
                                });
                            }
                        }
                        
                    }).then(function() { 
                        deleteUserMaster();
                        deleteCognitoUser();

                    }).then(function() {
                        if (notificationData != undefined && notificationData.flag == '1') {                            
                            var emailParam = generateGoodbyeParam();
                            sendEmail(emailParam).then(resolve,reject);
                        }      
                    });    
                    
                break;
                    
                default:
                    throw new Error(`Unsupported method "${event.httpMethod}"`);
            }    
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
            WHERE up.userid = '" + userid + "'";                    
    return executeQuery(sql).then(function(result) {
        UPIDdata = result[0];
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
            SET nActiveUsers = nActiveUser - 1 \
            WHERE pcid  = '" + pcid + "'";
    return executeQuery(sql);  
}

// function updateProductChannel(pcid) {
//     sql = "UPDATE ProductChannel SET status = 'inactive' where pcid = '" + pcid + "'";
//     return executeQuery(sql);
// }

// function getUserProductChannel(upid) {
//     sql = "SELECT * FROM UserProductChannel where upid = '" + upid + "'";
//     return executeQuery(sql).then(function(result) {
//         userProductChannelData = result[0];
//         console.log("userProductChannelData: ", userProductChannelData);
//     });
// }

// function getProductChannelMapping(upcid) {
//     sql = "SELECT * FROM ProductChannelMapping where upcid = '" + upcid + "'";
//     return executeQuery(sql).then(function(result) {
//         productChannelMappingData = result[0];
//         console.log("productChannelMappingData: ", productChannelMappingData);
//     });
// }

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
    sql = "SELECT * FROM UserPool where userid = '" + userid + "'";
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
    sql = "UPDATE Subscription SET status = 'Cancelled' where idUserPool = '" + idUserPool + "'";
    return executeQuery(sql);
}

function getCognitoUser() {
    const cognito = new AWS.CognitoIdentityServiceProvider({ region: process.env.REGION });

    return cognito.adminGetUser({
        UserPoolId: process.env.COGNITO_POOLID,
        Username: userid, 
        
    }).promise().then(function(data) {
        console.log("UserAttributes", data.UserAttributes);
        name = data.UserAttributes[1].Value;   
        email = data.UserAttributes[2].Value;   
        org = "test";
    });
}

function deleteCognitoUser() {
    const cognito = new AWS.CognitoIdentityServiceProvider({ region: process.env.REGION });
    cognito.adminDeleteUser({
        UserPoolId: process.env.COGNITO_POOLID,
        Username: userid,
    });
}

// function getActiveSubscription(id) {    
//     sql = "SELECT * FROM Subscription where upid = '" + id + "' and subscriptionStatus = 'active'";
//     return executeQuery(sql).then(function(result) {
//         subscriptionData = result[0];
//         console.log("activeSubscriptionData: ", activeSubscriptionData);
//     });
// }

function deleteUserProduct(id) {
    sql = "DELETE FROM UserProduct  where upid = '" + id + "'";
    return executeQuery(sql);
}

// function deleteProductMaster(id) {
//     sql = "DELETE FROM ProductMaster  where upid = '" + id + "'";
//     return executeQuery(sql);
// }

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

function updateUserAttribute(params, username){
    let cognitoISP = new AWS.CognitoIdentityServiceProvider({ region: process.env.REGION });
    return new Promise((resolve, reject) => {
        console.log("params: ", params);
        let attrib = {
            UserAttributes: [{
                    Name: "name",
                    Value: params.name 
            }
            // ,{
            //         Name: "organization",
            //         Value: params.organization
            // }
            ],
            UserPoolId: process.env.COGNITO_POOLID,
            Username: username
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
            ToAddresses: [email]
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
            ToAddresses: [email]
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

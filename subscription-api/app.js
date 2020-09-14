var mysql = require('mysql');
var AWS = require('aws-sdk');

var sourceEmail = process.env.SOURCE_EMAIL;
var supportEmail = process.env.SUPPORT_EMAIL;

var connection = mysql.createConnection({
    host: process.env.RDS_ENDPOINT,
    user: process.env.RDS_USERNAME,
    password: process.env.RDS_PASSWORD,
    database: process.env.RDS_DATABASE
});

var sql;
var userid;
var idUserPool;
var deletePromises = [];
var userMasterData;

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
    };

    try {
        body = await new Promise((resolve, reject) => {

            getCognitoUser(function(data) {              
                console.log("Cognito UserAttributes: ", data.UserAttributes);
                fname = data.UserAttributes[1].Value;   
                femail = data.UserAttributes[2].Value;   
                forg = "test";     

            }).then(function() {
                switch (event.httpMethod) {

                    case 'GET':
                        getIdPool().then(function(result) {
                            if (result != undefined) {
                                getSubscriptionDetails(result.idUserPool).then(resolve, reject);
                            }
                        }, reject);
                    break;
    
                    case 'POST':
                    
                    break;
                        
                    case 'PUT':
                        if (params.plan == 'Sandbox') {
                            throw new Error("Not authorized.");
                            
                        } else {
                            getUserMasterPUT().then(function(result) {
                                if (result == undefined) {
                                    throw new Error("Not authorized.");                                
                                    
                                } else {
                                    if (result.type == 'User') {
                                        throw new Error("Not authorized.");    
                                    } else if (result.type == 'Admin') {
                                        idUserPool = result.idUserPool;
                                        
                                        if (params.updateType == 'Product') {
                                            if (params.productAlias != undefined && params.upid != undefined) {
                                                updateUserProductPUT(params.productAlias, params.upid);
                                            }

                                        } else if (params.updateType == 'Channel') {
                                            updateUserProductChannelPUT(params.channelname, 
                                                                    params.channelURL, params.upcid).then(resolve, reject);
                                            updateProductChannelPUT(params.upcid).then(resolve, reject);
                                            
                                        }
                                    }
                                }
                                
                            }, reject).then(function() {
                                var emailParam = generateUpdateEmail(params.upid, params.upcid);
                                sendEmail(emailParam).then(resolve, reject);
                            },reject);
                        }
                       
                    break;
                    
                    case 'DELETE': 
                    
                        deletePromises.push(getUserMaster());
                        
                        Promise.all(deletePromises).then(function() {
                            if (userMasterData.userType == 'e') {
                                throw new Error("Not authorized.");                            
                            }
                            
                            if (params.plan == 'Sandbox') {
                                getSandboxIdUserPool().then(function(result) {
                                    console.log("getSandboxIdUserPool result: ", result.idUserPool);
                                    if (result.idUserPool != undefined) {
                                       deleteFromUserPool(result.idUserPool).then(resolve, reject); 
                                    }
                                }, reject);
                                
                            } else {
                                getAdminIdUserPool().then(function(result) {
                                    console.log("getAdminIdUserPool result: ", result.idUserPool);                                
                                    
                                    if (result == undefined || result == null) {
                                        throw new Error("Not authorized.");
                                        
                                    } else {
                                        getSubscription(params.upid, result.idUserPool).then(function(result) {
                                            if (result == undefined || result == null) {
                                                throw new Error("Not authorized.");
                                                
                                            } else {
                                                if (params.updateType == 'Product' 
                                                        && (params.upid == undefined || params.upid == null)) {
                                                    throw new Error("upid is missing.");
                                                    
                                                } else if (params.updateType == 'Channel' 
                                                            && (params.upcid == undefined || params.upcid == null)) {
                                                    throw new Error("upcid is missing.");
                                                }
                                            }
                                        }, reject);
                                    }
                                });
                            }
                                                    
                        }, reject).then(function() {
                            getUserProductChannel(params.upcid, params.upid).then(function(result) {
                                if (result == undefined) {
                                    if (params.updateType == 'Product' || params.updateType == 'Channel') {
                                        cancelSubscription(idUserPool, params.upid).then(resolve, reject);
                                        decreaseActiveUsersFromProductChannel(params.upcid).then(resolve, reject);
                                        setInactiveProductChannel(params.upcid).then(resolve, reject);
                                        deleteUserProduct(params.upid).then(resolve, reject);
                                    }
                                }          
                            }, reject);     
                                               
                        }, reject).then(function() {
                            
                            if (params.updateType == 'Channel') {
                                decreaseActiveUsersFromProductChannel(params.upcid).then(resolve, reject);
                                setInactiveProductChannel(params.upcid).then(resolve, reject);
                                deleteUserProductChannel(params.upcid).then(resolve, reject);
                                
                            } else if (params.updateType == 'Product') {
                                getNotificationFlag.then(function(result) {
                                    if (result.flag == '1') {
                                        var emailParam = generateCancelEmail();
                                        sendEmail(emailParam).then(resolve,reject);
                                    }
                                }, reject);
                            }
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

//COMMON FUNCTIONS

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

function getCognitoUser() {
    const cognito = new AWS.CognitoIdentityServiceProvider({ region: process.env.REGION });

    return cognito.adminGetUser({
        UserPoolId: process.env.COGNITO_POOLID,
        Username: userid, 
        
    }).promise();
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
    sql = "SELECT idUserPool \
            FROM UserPool up \
            JOIN Subscription s ON (s.idUserPool = up.idUserPool) \
            WHERE up.type = 'admin' \
            AND s.idProductPlan = 'pp1' \
            AND s.subscriptionStatus = 'active' ";                    
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
            WHERE um.userStatus <> 'beta' \
            AND up.type = 'admin' \
            AND um.userid '" + userid + "'";
    return executeQuery(sql);
}

function getSubscription(upid, idUserPool) {
    sql = "SELECT subscriptionID \
            FROM Subscription \
            WHERE upid = '" + upid + "' \
            AND idUserPool = '" + idUserPool + "'";
    return executeQuery(sql);    
}

function getUserProductChannel(upcid, upid) {
    sql = "SELECT upcid FROM UserProductChannel \
            WHERE upcid <> '" + upcid + "' \
            AND upid = '" + upid + "'";
    return executeQuery(sql);
}

function cancelSubscription(idUserPool, upid) {
    sql = "UPDATE Subscription \
            SET cancelledOn = GETDATE() \
            WHERE idUserPool = '" + idUserPool + "' \
            AND upid = '" + upid + "'";
    return executeQuery(sql);
}

function decreaseActiveUsersFromProductChannel(upcid) {
    sql = "UPDATE ProductChannel \
            SET nActiveUsers = nActiveUsers - 1 \
            WHERE pcid IN (SELECT pcid FROM ProductChannelMapping \
                            WHERE upcid in '" + upcid + "')";
    return executeQuery(sql);
}

function setInactiveProductChannel(upcid) {
    sql = "UPDATE ProductChannel \
            SET status = 'inactive' \
            WHERE pcid IN (SELECT pcid FROM ProductChannelMapping \
                            WHERE upcid in '" + upcid + "')";
    return executeQuery(sql);
}

function deleteUserProduct(upid) {
    sql = "DELETE FROM UserProduct \
            WHERE upid = '" + upid + "'" ;
    return executeQuery(sql);
}

function deleteUserProductChannel(upcid) {
    sql = "DELETE FROM UserProductChannel \
            WHERE upcid = '" + upcid + "'" ;
    return executeQuery(sql);
}

function getNotificationFlag() {
    sql = "SELECT flag FROM Notification  \
            WHERE userid = '" + userid + "' \
            AND notificationTypeID = '1' ";
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

function getSubscriptionDetails(idUserPool) {
    sql = "SELECT s.idProductPlan, s.endDate, s.subscriptionStatus, s.upid, \
            up.productAlias, upc.upcid, upc.channelName, upc.channelURL \
             FROM UserProductChannel upc \
             JOIN UserProduct up ON (upc.upid = up.upid) \
             JOIN Subscription s ON (up.upid = s.upid) \
             WHERE s.idUserPool = '" + idUserPool + "'" ;
    return executeQuery(sql);    
}

//PUT FUNCTIONS

function getUserMasterPUT() {
    sql = "SELECT up.type, up.idUserPool \
            FROM UserPool up \
            JOIN UserMaster um ON (up.userid = um.userid) \
            WHERE um.userStatus <> 'beta' \
            AND um.userType <> 'e' \
            AND um.userid '" + userid + "'" ;
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
                channelURL = '" + channelURL + "', \
                status = 'NEW' \
            WHERE upcid = '" + upcid + "' ";
    return executeQuery(sql);
}

function updateProductChannelPUT(upcid) {
    sql = "UPDATE ProductChannel \
            SET status = 'review' \
            WHERE pcid = (SELECT pcid from \
                        ProductChannelMapping \
                        WHERE upcid = '" + upcid + "' ";
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


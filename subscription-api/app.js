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
var fidUserPool;
var deletePromises = [];
var userMasterData;
var notificationData;

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
                            if (result != undefined) {
                                getSubscriptionDetails().then(resolve, reject);
                            }
                        }, reject);
                    break;
    
                    case 'POST':
                        var idPool;
                        var upid; 

                        if (params.plan == 'Sandbox') {
                            getUserTypePOST.then(function(result) {

                                if (result[0].userStatus != 'NEW') {
                                    throw new Error("Not authorized");

                                } else {
                                    getSandboxIdUserPool().then(function(data) {
                                        if (data != undefined && data.length > 0) {
                                            insertUserPoolPOST(data[0].idUserPool).then(resolve, reject);
                                            updateUserBeta().then(resolve, reject);
                                        }                                        
                                    }).then(function() {
                                        getNotification().then(function() {
                                            if (notificationData.flag == '1') {
                                                var emailParam = generateSandboxEmail();
                                                sendEmail(emailParam).then(resolve, reject);
                                            }
                                        }, reject);
                                    }, reject);
                                }
                            }, reject);
                        }

                        if (params.plan == undefined || params.plan == null) {
                            getUserPoolTypePOST().then(function(data) {
                                if (data[0].type == "USER") {
                                    throw new Error("Not authorized");

                                } else if (data == undefined) {
                                    addAdminToUserPoolPOST().then(resolve,reject);
                                    updateUserMasterPOST().then(resolve,reject);
                                    getNewIdUserPoolPOST().then(function(res) {
                                        idPool = res[0].idUserPool;
                                    }, reject);

                                } else if (data != undefined) {
                                    idPool = data[0].idUserPool
                                }
                                
                            }, reject).then(function() {
                                if (params.upid == undefined || params.upid == null) { //New Product
                                    createNewProductPOST(params).then(function() {
                                        getUpIDPOST().then(function(result) {

                                            if (result != undefined) {
                                                upid = result[0].upid;
                                                createUserProductChannelPOST(upid, params).then(resolve,reject);
                                                createSubscriptionPOST(upid, idPool).then(resolve,reject);
                                            }
                                        }, reject);
                                    }, reject);
                                }

                            }, reject).then(function() {
                                if (params.upcid != null) { //New Channel
                                    createUserProductChannelPOST(params.upid, params).then(resolve,reject);
                                }

                            }, reject).then(function() {
                                if (params.upid == undefined) {
                                    params.upid = upid;
                                }
                                var emailParam = generatePOSTEmail(params);
                                sendEmail(emailParam).then(resolve, reject);

                            },reject);
                        }
                    
                    break;
                        
                    case 'PUT':
                        if (params.plan == 'Sandbox') {
                            throw new Error("Not authorized.");
                            
                        } else {
                            getUserMasterPUT().then(function(result) {
                                if (result == undefined) {
                                    throw new Error("Not authorized.");                                
                                    
                                } else {
                                    let type = result[0].type;

                                    if (type == 'USER') {
                                        throw new Error("Not authorized.");    

                                    } else if (type == 'ADMIN') {
                                        idUserPool = result[0].idUserPool;
                                        
                                        if (params.updateType == 'Product') {
                                            if (params.productAlias != undefined && params.upid != undefined) {
                                                updateUserProductPUT(params.productAlias, params.upid);
                                            }

                                        } else if (params.updateType == 'Channel') {
                                            updateUserProductChannelPUT(params.channelName, 
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
                            if (userMasterData.userType == 'E') {
                                throw new Error("Not authorized.");                            
                            }
                            
                            if (params.plan == 'Sandbox') {
                                getSandboxIdUserPool().then(function(result) {
                                    console.log("getSandboxIdUserPool result: ", result);
                                    if (result != undefined) {
                                        fidUserPool = result[0].idUserPool;
                                        deleteFromUserPool(fidUserPool).then(resolve, reject); 
                                    }
                                }, reject);
                                
                            } else {
                                getAdminIdUserPool().then(function(result) {
                                    console.log("getAdminIdUserPool result: ", result);                                
                                    
                                    if (result == undefined || result == null) {
                                        throw new Error("Not authorized.");
                                        
                                    } else {
                                        fidUserPool = result[0].idUserPool;
                                        getSubscription(params.upid, fidUserPool).then(function(data) {
                                            if (data == undefined || data == null) {
                                                throw new Error("No subscription found");
                                                
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
                            
                                
                                    if (params.updateType == 'Product') {
                                        cancelSubscription(fidUserPool, params.upid).then(resolve, reject);
                                        
                                    }else if (params.updateType == 'Channel') {
                                        decreaseActiveUsersFromProductChannel(params.upcid).then(resolve, reject);
                                        setInactiveProductChannel(params.upcid).then(resolve, reject);
                                        deleteUserProductChannel(params.upcid).then(resolve, reject);
                                    }    
                                
                                               
                        }, reject).then(function() {
                            
                            if (params.updateType == 'Product') {
                                getNotification().then(function() {
                                    if (notificationData.flag == '1') {
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
    sql = "SELECT idUserPool \
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
            WHERE um.userStatus <> 'BETA' \
            AND up.type = 'ADMIN' \
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
            SET status = 'INACTIVE' \
            WHERE nActiveusers = 0 and pcid IN (SELECT pcid FROM ProductChannelMapping \
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
    sql = "SELECT pp.plan, s.endDt, s.nxtBillingDt, s.subscriptionStatus, s.upid, \
            up.productAlias, upc.upcid, upc.channelName, upc.channelURL \
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
            WHERE um.userStatus <> 'BETA' \
            AND um.userType <> 'E' \
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
            SET status = 'REVIEW' \
            WHERE pcid = (SELECT pcid FROM \
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

function getUserPoolTypePOST() {
    sql = "SELECT up.type, up.idUserPool \
             FROM UserPool up \
             JOIN UserMaster um ON (up.userid = um.userid) \
             WHERE um.userStatus != 'BETA' \
             AND um.userType != 'E' AND um.userid = '" + userid + "'" ;
    return executeQuery(sql);    
}

function addAdminToUserPoolPOST() {
    sql = "INSERT INTO UserPool (type, userid) \
            VALUES ('ADMIN', '" + userid + "')";
    return executeQuery(sql);
}

function updateUserMasterPOST() {
    sql = "UPDATE UserMaster \
            SET userStatus = 'PROSPECT' \
            WHERE userid = '" + userid + "'";
    return executeQuery(sql);
}

function getNewIdUserPoolPOST() {
    sql = "SELECT idUserPool \
             FROM UserPool  \
             WHERE type = 'ADMIN' \
             AND userid = '" + userid + "'" ;
    return executeQuery(sql);    
}

function createNewProductPOST(params) {
    sql = "INSERT INTO UserProduct (status, productAlias) \
            VALUES ('NEW', '" + params.productAlias + "')";
    return executeQuery(sql);      
}

function getUpIDPOST() {
    sql = "SELECT upid FROM UserProduct \
            WHERE createdOn = (SELECT MAX(createdOn) FROM UserProduct)";
    return executeQuery(sql);
}

function createUserProductChannelPOST(upid, params) {
    sql = "INSERT INTO UserProductChannel (upid, status, channelName, channelURL) \
            VALUES ('" + upid + "', 'NEW', '" + params.channelName + "', '" + params.channelURL + "')";
    return executeQuery(sql);  
}

function createSubscriptionPOST(upid, idUserPool) {
    sql = "INSERT INTO Subscription (idProductPlan, upid, idUserPool, subscriptionStatus) \
            VALUES ('PP5', '" + upid + "', '" + idUserPool + "', 'NEW')";
    return executeQuery(sql);  
}

function getUserTypePOST() {
    sql = "SELECT userStatus FROM UserMaster WHERE userid = '" + userid + "'"; 
    return executeQuery(sql);  
}

function insertUserPoolPOST(idUserPool) {
    sql = "INSERT INTO UserPool (idUserPool, type, userid) \
            VALUES (" + idUserPool + "', 'USER', '" + userid + "')";
    return executeQuery(sql);
}

function updateUserBeta() {
    sql = "UPDATE UserMaster \
            SET userStatus = 'BETA' \
            WHERE = '" + userid + "'";
    return executeQuery(sql);
}

function generatePOSTEmail(params) {

    if (params.upid == undefined) params.upid = '';
    if (params.upcid == undefined) params.upcid = '';
    if (params.channelURL == undefined) params.channelURL = '';
    if (params.channelName == undefined) params.channelName = '';
    if (params.productAlias == undefined) params.productAlias = '';

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
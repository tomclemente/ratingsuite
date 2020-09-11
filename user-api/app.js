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
var authname;
var organization;
var deletePromises = [];
var userPoolData;
var userMasterData;
var subscriptionData;
var notificationData;
var userProductChannelData;
var activeSubscriptionData;
var productChannelMappingData;




exports.handler = async (event, context) => {

    organization = event.requestContext.authorizer.claims.organization;
//    authname = event.requestContext.authorizer.claims.name;

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
                    sql = "SELECT um.userid, um.name, um.userType, um.organization, um.userStatus, up.type, n.flag
                            FROM UserMaster um
                            INNER JOIN UserPool up on um.userid = up.userid
                            INNER JOIN Notification n on um.userid = n.userid and n.notificationTypeID = 1
                            WHERE um.userid = '" + userid + "'";
                    executeQuery(sql).then(resolve, reject);
                break;

                case 'POST': 
                    insertUserMaster(params,username).then(function() {
                        insertNotification();                        
                        var emailParam = generateWelcomeParam(username);
                        sendEmail(emailParam).then(resolve,reject);
                    });
                break;
                    
                case 'PUT':
                    updateUserAttribute(params.attributes, username, process.env.COGNITO_POOLID).then(function() {
                        sql = "UPDATE UserMaster 
                                SET organization = '" + params.organization + "'
                                organization = '" + params.organization + "'
                                WHERE userid = '" + username + "'";
                        executeQuery(sql).then(resolve, reject);  
                    }, reject);
                break;
                
                case 'DELETE': 
                
                    deletePromises.push(getUserMaster());
                    deletePromises.push(getUserPool());
                    deletePromises.push(getNotification());
                    
                    Promise.all(deletePromises).then(function() {
                        
                        
                    });
              
                
    //                "1. If (userpool.type = ‘User’ and subscription.idProductPlan = 'pp1) or (userpool.type = ‘Admin’ and usermaster.usertype <> 'E'), 
//    
//    Select up.type,idUserPool from UserPool where userid = ""username""
//    Select um.userType from UserMaster where userid = ""username""
//    Select idProductPlan,upid from Subscription where idUserPool = ""idUserPool""
//    
//    Update Subscription
//    set status = 'Cancelled'
//    where idUserPool = 
//    
//    2. 
//    
//    
//    Step a: Get all the upid associated with the userid
//    
//    var[] user_upid = Select s.upid from Subscription s JOIN UserPool up on s.idUserPool = up.idUserPool  WHERE up.userid = ' "" + username + "" '
//    
//    Step b: Get all the pcids associated with the userid
//    
//    var[] user_pcid = Select pcid from ProductChannelMapping where upcid  in (Select upcid from UserProductChannel where upid in ' "" + user_upid + "" ')
//    
//    Step c: Update ProductChannelMapping for unsubscribed Products
//    
//    Update table ProductChannel
//    Set nActiveUsers = nActiveUsers - 1 
//    where pcid in ' "" + user_pcid + "" ' 
//    
//    Update table ProductChannel
//    Set status = 'inactive' 
//    where nActiveUsers = 0 and pcid in  ' "" + user_pcid + "" ' 
//    
//    
//    3. Delete from UserProduct
//        where upid in ""user_upid""
//        Cascade delete - userproductchannel, productchannelmapping, productmapping"
                
                
                

                    deletePromises.push(getUserMaster());
                    deletePromises.push(getUserPool());
                    deletePromises.push(getNotification());
                    
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
                        
                        //send an email and delete cognito user pool
                        if (notificationData != undefined && notificationData.flag == '1') {
                            deleteCognitoUser();
                            var emailParam = generateGoodbyeParam();
                            sendEmail(emailParam).then(resolve,reject);
                        }      

                    }).then(function() { //do some cleanup
                        deleteUserMaster();

                    }).then(function() { 
                        getActiveSubscription(username).then(function() {
                            if (activeSubscriptionData == undefined || activeSubscriptionData == null) {
                                deleteUserProduct(username);
                            }                            
                        }).then(function() {

                            if (activeSubscriptionData != undefined && activeSubscriptionData.upid != null) {
                                getUserProductChannel(activeSubscriptionData.upid).then(function() {

                                    if (userProductChannelData != undefined && userProductChannelData.upcid != null) {
                                        getProductChannelMapping(userProductChannelData.upcid).then(function() {

                                            if (productChannelMappingData != undefined && productChannelMappingData.pcid != null) {
                                                updateProductChannel(productChannelMappingData.pcid).then(resolve,reject);
                                            }
                                        });
                                    }   
                                });
                            }
                        });
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

function updateProductChannel(pcid) {
    sql = "UPDATE ProductChannel SET status = 'inactive' where pcid = '" + pcid + "'";
    return executeQuery(sql);
}

function getUserProductChannel(upid) {
    sql = "SELECT * FROM UserProductChannel where upid = '" + upid + "'";
    return executeQuery(sql).then(function(result) {
        userProductChannelData = result[0];
        console.log("userProductChannelData: ", userProductChannelData);
    });
}

function getProductChannelMapping(upcid) {
    sql = "SELECT * FROM ProductChannelMapping where upcid = '" + upcid + "'";
    return executeQuery(sql).then(function(result) {
        productChannelMappingData = result[0];
        console.log("productChannelMappingData: ", productChannelMappingData);
    });
}

function deleteUserMaster() {
    sql = "DELETE FROM UserMaster where userid = '" + username + "'";
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
    sql = "UPDATE Subscription SET subscriptionStatus = 'cancelled' where idUserPool = '" + idUserPool + "'";
    return executeQuery(sql);
}

function deleteCognitoUser() {
    const cognito = new AWS.CognitoIdentityServiceProvider({ region: process.env.REGION });
    cognito.adminDeleteUser({
        UserPoolId: process.env.COGNITO_POOLID,
        Username: 'sample', //should be username, for testing purposes only
    });
}

function getActiveSubscription(id) {    
    sql = "SELECT * FROM Subscription where upid = '" + id + "' and subscriptionStatus = 'active'";
    return executeQuery(sql).then(function(result) {
        subscriptionData = result[0];
        console.log("activeSubscriptionData: ", activeSubscriptionData);
    });
}

function deleteUserProduct(id) {
    sql = "DELETE FROM UserProduct  where upid = '" + id + "'";
    return executeQuery(sql);
}

function deleteProductMaster(id) {
    sql = "DELETE FROM ProductMaster  where upid = '" + id + "'";
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

function updateUserAttribute(userAttributes, username, userPoolId){
    let cognitoISP = new AWS.CognitoIdentityServiceProvider({ region: process.env.REGION });
    return new Promise((resolve, reject) => {
        console.log("userAttributes: ", userAttributes);
        let params = {
            UserAttributes: userAttributes,
            UserPoolId: userPoolId,
            Username: username
        };

        cognitoISP.adminUpdateUserAttributes(params, (err, data) => err ? 
        reject(err) : resolve(data));
    });
};

function insertUserMaster(params, username) {
    sql = "INSERT INTO UserMaster (userid, name, userStatus, userType, organization) \
        VALUES (\
            '" + userid + "',\
            '" + authname + "',\
            'NEW',\
            'NE',\
            '" + organization + "'";
            
    return executeQuery(sql);
};

function insertNotification(){
    sql = "INSERT INTO Notification (userid, notificationTypeID, flag) \
        VALUES (\
            '" + userid + "',\
            '1',\
            '1'";
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
            ToAddresses: [username]
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
            ToAddresses: [username]
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

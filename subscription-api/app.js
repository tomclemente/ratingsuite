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
                                        // console.log("Returning Params: ", params);
                                        // resolve(params);

                                        getIdPool().then(function(result) {
                                            if (!isEmpty(result)) {
                                                getSubscriptionDetails().then(function(data) {
                                                    resolve(data);
                                                }, reject);
                                            }
                                        }, reject).catch(err => {
                                            reject({ statusCode: 500, body: err.message });
                                        });

                                    }).catch(err => reject({ statusCode: 500, body: err.message }));
                                }

                            } else {
                                if (userMasterData.userStatus == 'E') {
                                    throw new Error("Not authorized.");
                                }

                                getUserPoolTypePOST().then(async function(data) {
                                    if (!isEmpty(data) && data[0].type == "USER") {
                                        throw new Error("Not authorized.");
    
                                    } else if (isEmpty(data)) {
                                        await addAdminToUserPoolPOST();
                                        const res = await getNewIdUserPoolPOST();
                                        idPool = res[0].idUserPool;    

                                    } else if (!isEmpty(data)) {
                                        idPool = data[0].idUserPool
                                    }
                                    
                                }).then(function() {
                                    if (isEmpty(params.upid)) { //New Product
                                        return createNewProductPOST(params);
                                    } else { //New Channel
                                        return createUserProductChannelPOST(params.upid, params).then(function() {
                                            return getRecentUserProductChannel(params.upid, params).then(function(data) {
                                                params.upcid = data.upcid;
                                            });
                                        });
                                    }

                                }).then(async function() {
                                    if (isEmpty(params.upid)) {
                                        const result = await getUpIDPOST();
                                        params.upid = result[0].upid;
                                        
                                        return createUserProductChannelPOST(params.upid, params).then(function() {
                                            return createSubscriptionPOST(params.upid, idPool).then(function() {
                                                return getRecentUserProductChannel(params.upid, params).then(function(data) {
                                                    params.upcid = data.upcid;
                                                });
                                            })
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
                                            if (!isEmpty(params.upcid) && !isEmpty(params.channelName) && !isEmpty(params.channelURL)) {
                                                await updateUserProductChannelPUT(params.channelName, params.channelURL, params.upcid);
                                                //await updateProductChannelPUT(params.upcid);
                                            }
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

                                            } else if (params.updateType == 'Subscription' && isEmpty(params.upid)) {
                                                throw new Error("upid is missing.");

                                            }else if (params.updateType == 'Channel' && isEmpty(params.upcid)) {
                                                throw new Error("upcid is missing.");
                                            }

                                            if (params.updateType == 'Product') {
                                                await cancelSubscriptionDel(g_idUserPool, params.upid);
                                                await deleteUserProduct(params.upid);

                                            } else if (params.updateType == 'Channel') {
                                                await decreaseActiveUsersFromProductChannel(params.upcid);
                                                await setInactiveProductChannel(params.upcid);
                                                await deleteUserProductChannel(params.upcid);

                                            } else if (params.updateType == 'Subscription') {
                                                await cancelSubscription(g_idUserPool, params.upid);
                                            }
                                        }
                                    }
                                }).catch(err => reject({ statusCode: 500, body: err.message }));
                            }          
                                                                      
                        }, reject).then(function() {
                            if (!isEmpty(notificationData)) {
                                if (params.updateType == 'Product' && !isEmpty(subscriptionData) && subscriptionData.subscriptionStatus == 'ACTIVE') {
                                    return sendEmail(generateCancelProductEmail(params));
                                } else if (params.updateType == 'Subscription' && !isEmpty(subscriptionData) && subscriptionData.subscriptionStatus == 'ACTIVE') {
                                    return sendEmail(generateCancelSubscriptionEmail(params));
                                }
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

function cancelSubscriptionDel(idUserPool, upid) {
    sql = "UPDATE Subscription \
            SET cancelledOn = CURRENT_DATE() , \
            subscriptionStatus = 'CANCELLED' \
            WHERE idUserPool = '" + idUserPool + "' \
            AND upid = '" + upid + "'";
    return executeQuery(sql);
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

function generateCancelProductEmail(params) {
    const product = params.productAlias;
    var param = {
        Destination: {
            ToAddresses: [femail]
        },
        Message: {
            Body: {
                Html: {
                  
                  Charset: "UTF-8",
                  Data:
                    `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
                    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office" style="width:100%;font-family:arial, 'helvetica neue', helvetica, sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;padding:0;Margin:0">
                     <head> 
                      <meta charset="UTF-8"> 
                      <meta content="width=device-width, initial-scale=1" name="viewport"> 
                      <meta name="x-apple-disable-message-reformatting"> 
                      <meta http-equiv="X-UA-Compatible" content="IE=edge"> 
                      <meta content="telephone=no" name="format-detection"> 
                      <title>Subscription E-mails</title> 
                      <!--[if (mso 16)]>
                        <style type="text/css">
                        a {text-decoration: none;}
                        </style>
                        <![endif]--> 
                      <!--[if gte mso 9]><style>sup { font-size: 100% !important; }</style><![endif]--> 
                      <!--[if gte mso 9]>
                    <xml>
                        <o:OfficeDocumentSettings>
                        <o:AllowPNG></o:AllowPNG>
                        <o:PixelsPerInch>96</o:PixelsPerInch>
                        </o:OfficeDocumentSettings>
                    </xml>
                    <![endif]--> 
                      <!--[if !mso]><!-- --> 
                      <link href="https://fonts.googleapis.com/css?family=Open+Sans:400,400i,700,700i" rel="stylesheet"> 
                      <!--<![endif]--> 
                      <style type="text/css">
                    #outlook a {
                        padding:0;
                    }
                    .ExternalClass {
                        width:100%;
                    }
                    .ExternalClass,
                    .ExternalClass p,
                    .ExternalClass span,
                    .ExternalClass font,
                    .ExternalClass td,
                    .ExternalClass div {
                        line-height:100%;
                    }
                    .es-button {
                        mso-style-priority:100!important;
                        text-decoration:none!important;
                    }
                    a[x-apple-data-detectors] {
                        color:inherit!important;
                        text-decoration:none!important;
                        font-size:inherit!important;
                        font-family:inherit!important;
                        font-weight:inherit!important;
                        line-height:inherit!important;
                    }
                    .es-desk-hidden {
                        display:none;
                        float:left;
                        overflow:hidden;
                        width:0;
                        max-height:0;
                        line-height:0;
                        mso-hide:all;
                    }
                    @media only screen and (max-width:600px) {p, ul li, ol li, a { font-size:16px!important; line-height:150%!important } h1 { font-size:30px!important; text-align:center; line-height:120%!important } h2 { font-size:26px!important; text-align:center; line-height:120%!important } h3 { font-size:20px!important; text-align:center; line-height:120%!important } h1 a { font-size:30px!important } h2 a { font-size:26px!important } h3 a { font-size:20px!important } .es-menu td a { font-size:16px!important } .es-header-body p, .es-header-body ul li, .es-header-body ol li, .es-header-body a { font-size:16px!important } .es-footer-body p, .es-footer-body ul li, .es-footer-body ol li, .es-footer-body a { font-size:16px!important } .es-infoblock p, .es-infoblock ul li, .es-infoblock ol li, .es-infoblock a { font-size:12px!important } *[class="gmail-fix"] { display:none!important } .es-m-txt-c, .es-m-txt-c h1, .es-m-txt-c h2, .es-m-txt-c h3 { text-align:center!important } .es-m-txt-r, .es-m-txt-r h1, .es-m-txt-r h2, .es-m-txt-r h3 { text-align:right!important } .es-m-txt-l, .es-m-txt-l h1, .es-m-txt-l h2, .es-m-txt-l h3 { text-align:left!important } .es-m-txt-r img, .es-m-txt-c img, .es-m-txt-l img { display:inline!important } .es-button-border { display:block!important } a.es-button { font-size:20px!important; display:block!important; border-width:10px 0px 10px 0px!important } .es-btn-fw { border-width:10px 0px!important; text-align:center!important } .es-adaptive table, .es-btn-fw, .es-btn-fw-brdr, .es-left, .es-right { width:100%!important } .es-content table, .es-header table, .es-footer table, .es-content, .es-footer, .es-header { width:100%!important; max-width:600px!important } .es-adapt-td { display:block!important; width:100%!important } .adapt-img { width:100%!important; height:auto!important } .es-m-p0 { padding:0px!important } .es-m-p0r { padding-right:0px!important } .es-m-p0l { padding-left:0px!important } .es-m-p0t { padding-top:0px!important } .es-m-p0b { padding-bottom:0!important } .es-m-p20b { padding-bottom:20px!important } .es-mobile-hidden, .es-hidden { display:none!important } tr.es-desk-hidden, td.es-desk-hidden, table.es-desk-hidden { width:auto!important; overflow:visible!important; float:none!important; max-height:inherit!important; line-height:inherit!important } tr.es-desk-hidden { display:table-row!important } table.es-desk-hidden { display:table!important } td.es-desk-menu-hidden { display:table-cell!important } .es-menu td { width:1%!important } table.es-table-not-adapt, .esd-block-html table { width:auto!important } table.es-social { display:inline-block!important } table.es-social td { display:inline-block!important } }
                    </style> 
                     </head> 
                     <body style="width:100%;font-family:arial, 'helvetica neue', helvetica, sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;padding:0;Margin:0"> 
                      <div class="es-wrapper-color" style="background-color:#F6F6F6"> 
                       <!--[if gte mso 9]>
                                <v:background xmlns:v="urn:schemas-microsoft-com:vml" fill="t">
                                    <v:fill type="tile" color="#f6f6f6"></v:fill>
                                </v:background>
                            <![endif]--> 
                       <table class="es-wrapper" width="100%" cellspacing="0" cellpadding="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;padding:0;Margin:0;width:100%;height:100%;background-repeat:repeat;background-position:center top"> 
                         <tr style="border-collapse:collapse"> 
                          <td valign="top" style="padding:0;Margin:0"> 
                           <table cellpadding="0" cellspacing="0" class="es-content" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;table-layout:fixed !important;width:100%"> 
                             <tr style="border-collapse:collapse"> 
                              <td align="center" style="padding:0;Margin:0"> 
                               <table class="es-content-body" align="center" cellpadding="0" cellspacing="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;background-color:transparent;width:600px"> 
                                 <tr style="border-collapse:collapse"> 
                                  <td align="left" style="padding:0;Margin:0;padding-top:20px;padding-left:20px;padding-right:20px"> 
                                   <table cellpadding="0" cellspacing="0" width="100%" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                     <tr style="border-collapse:collapse"> 
                                      <td align="center" valign="top" style="padding:0;Margin:0;width:560px"> 
                                       <table cellpadding="0" cellspacing="0" width="100%" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:10px;Margin:0;font-size:0"> 
                                           <table border="0" width="100%" height="100%" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                             <tr style="border-collapse:collapse"> 
                                              <td style="padding:0;Margin:0;border-bottom:0px solid #CCCCCC;background:none;height:1px;width:100%;margin:0px"></td> 
                                             </tr> 
                                           </table></td> 
                                         </tr> 
                                       </table></td> 
                                     </tr> 
                                   </table></td> 
                                 </tr> 
                               </table></td> 
                             </tr> 
                           </table> 
                           <table class="es-content" cellspacing="0" cellpadding="0" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;table-layout:fixed !important;width:100%"> 
                             <tr style="border-collapse:collapse"> 
                              <td align="center" style="padding:0;Margin:0"> 
                               <table class="es-content-body" cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;background-color:#FFFFFF;width:600px"> 
                                 <tr style="border-collapse:collapse"> 
                                  <td align="left" style="padding:0;Margin:0;padding-top:30px;padding-left:35px;padding-right:35px"> 
                                   <table width="100%" cellspacing="0" cellpadding="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                     <tr style="border-collapse:collapse"> 
                                      <td valign="top" align="center" style="padding:0;Margin:0;width:530px"> 
                                       <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;font-size:0px"><img class="adapt-img" src="https://hvrqpw.stripocdn.email/content/guids/CABINET_01f7abfd58bcd55aa3d33c1a0cb1722d/images/48041601285025942.png" alt style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic" width="350"></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:20px;padding-bottom:20px;font-size:0"> 
                                           <table border="0" width="100%" height="100%" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                             <tr style="border-collapse:collapse"> 
                                              <td style="padding:0;Margin:0;border-bottom:2px solid #F2F2F2;background:none;height:1px;width:100%;margin:0px"></td> 
                                             </tr> 
                                           </table></td> 
                                         </tr> 
                                        
                                         <tr style="border-collapse:collapse"> 
                                          <td align="left" style="Margin:0;padding-bottom:10px;padding-left:10px;padding-right:10px;padding-top:20px"><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:21px;color:#2A2E33">Per your request, below product has been deleted from your profile and subscription has been cancelled.<br><br></p><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:21px;color:#2A2E33">Product: ${product}<br><br></p><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:21px;color:#2A2E33">If you need help or have any questions, please&nbsp;<strong><a target="_blank" style="-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;font-size:14px;text-decoration:underline;color:#F29D38" href="mailto:support@ratingsuite.com">contact us</a></strong></p><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:arial, 'helvetica neue', helvetica, sans-serif;line-height:21px;color:#2A2E33"><br></p></td> 
                                         </tr> 
                                       </table></td> 
                                     </tr> 
                                   </table></td> 
                                 </tr> 
                                 <tr style="border-collapse:collapse"> 
                                  <td align="left" bgcolor="#555555" style="padding:0;Margin:0;padding-top:20px;padding-left:20px;padding-right:20px;background-color:#555555"> 
                                   <table cellpadding="0" cellspacing="0" width="100%" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                     <tr style="border-collapse:collapse"> 
                                      <td align="center" valign="top" style="padding:0;Margin:0;width:560px"> 
                                       <table cellpadding="0" cellspacing="0" width="100%" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;font-size:0px"><img class="adapt-img" src="https://hvrqpw.stripocdn.email/content/guids/CABINET_01f7abfd58bcd55aa3d33c1a0cb1722d/images/82141601285215249.png" alt style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic" width="200"></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:10px;padding-bottom:10px;font-size:0"> 
                                           <table cellpadding="0" cellspacing="0" class="es-table-not-adapt es-social" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                             <tr style="border-collapse:collapse"> 
                                              <td align="center" valign="top" style="padding:0;Margin:0"><a target="_blank" href="https://twitter.com/ratingsuite" style="-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-family:arial, 'helvetica neue', helvetica, sans-serif;font-size:14px;text-decoration:underline;color:#1376C8"><img title="Twitter" src="https://hvrqpw.stripocdn.email/content/assets/img/social-icons/circle-white/twitter-circle-white.png" alt="Tw" width="32" style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic"></a></td> 
                                             </tr> 
                                           </table></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:10px;padding-bottom:10px"><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:16px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:24px;color:#FFFFFF">2020 © Ratingsuite</p></td> 
                                         </tr> 
                                       </table></td> 
                                     </tr> 
                                   </table></td> 
                                 </tr> 
                               </table></td> 
                             </tr> 
                           </table> 
                           <table class="es-footer" cellspacing="0" cellpadding="0" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;table-layout:fixed !important;width:100%;background-color:transparent;background-repeat:repeat;background-position:center top"> 
                             <tr style="border-collapse:collapse"> 
                              <td align="center" style="padding:0;Margin:0"> 
                               <table class="es-footer-body" cellspacing="0" cellpadding="0" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;background-color:transparent;width:600px"> 
                                 <tr style="border-collapse:collapse"> 
                                  <td align="left" style="padding:0;Margin:0;padding-top:20px;padding-left:20px;padding-right:20px"> 
                                   <table cellpadding="0" cellspacing="0" width="100%" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                     <tr style="border-collapse:collapse"> 
                                      <td align="center" valign="top" style="padding:0;Margin:0;width:560px"> 
                                       <table cellpadding="0" cellspacing="0" width="100%" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:5px;Margin:0;font-size:0"> 
                                           <table border="0" width="100%" height="100%" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                             <tr style="border-collapse:collapse"> 
                                              <td style="padding:0;Margin:0;border-bottom:0px solid #CCCCCC;background:none;height:1px;width:100%;margin:0px"></td> 
                                             </tr> 
                                           </table></td> 
                                         </tr> 
                                       </table></td> 
                                     </tr> 
                                   </table></td> 
                                 </tr> 
                               </table></td> 
                             </tr> 
                           </table></td> 
                         </tr> 
                       </table> 
                      </div>  
                     </body>
                    </html>`
                }
              },
            Subject: { Data: "Ratingsuite: Product has been removed!" }
        },
        Source: sourceEmail
    };

    return param;
}

function generateCancelSubscriptionEmail(params) {
    const product = params.productAlias;
    var param = {
        Destination: {
            ToAddresses: [femail]
        },
        Message: {
            Body: {
                Html: {
                  
                  Charset: "UTF-8",
                  Data:
                    `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
                    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office" style="width:100%;font-family:arial, 'helvetica neue', helvetica, sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;padding:0;Margin:0">
                     <head> 
                      <meta charset="UTF-8"> 
                      <meta content="width=device-width, initial-scale=1" name="viewport"> 
                      <meta name="x-apple-disable-message-reformatting"> 
                      <meta http-equiv="X-UA-Compatible" content="IE=edge"> 
                      <meta content="telephone=no" name="format-detection"> 
                      <title>Subscription E-mails</title> 
                      <!--[if (mso 16)]>
                        <style type="text/css">
                        a {text-decoration: none;}
                        </style>
                        <![endif]--> 
                      <!--[if gte mso 9]><style>sup { font-size: 100% !important; }</style><![endif]--> 
                      <!--[if gte mso 9]>
                    <xml>
                        <o:OfficeDocumentSettings>
                        <o:AllowPNG></o:AllowPNG>
                        <o:PixelsPerInch>96</o:PixelsPerInch>
                        </o:OfficeDocumentSettings>
                    </xml>
                    <![endif]--> 
                      <!--[if !mso]><!-- --> 
                      <link href="https://fonts.googleapis.com/css?family=Open+Sans:400,400i,700,700i" rel="stylesheet"> 
                      <!--<![endif]--> 
                      <style type="text/css">
                    #outlook a {
                        padding:0;
                    }
                    .ExternalClass {
                        width:100%;
                    }
                    .ExternalClass,
                    .ExternalClass p,
                    .ExternalClass span,
                    .ExternalClass font,
                    .ExternalClass td,
                    .ExternalClass div {
                        line-height:100%;
                    }
                    .es-button {
                        mso-style-priority:100!important;
                        text-decoration:none!important;
                    }
                    a[x-apple-data-detectors] {
                        color:inherit!important;
                        text-decoration:none!important;
                        font-size:inherit!important;
                        font-family:inherit!important;
                        font-weight:inherit!important;
                        line-height:inherit!important;
                    }
                    .es-desk-hidden {
                        display:none;
                        float:left;
                        overflow:hidden;
                        width:0;
                        max-height:0;
                        line-height:0;
                        mso-hide:all;
                    }
                    @media only screen and (max-width:600px) {p, ul li, ol li, a { font-size:16px!important; line-height:150%!important } h1 { font-size:30px!important; text-align:center; line-height:120%!important } h2 { font-size:26px!important; text-align:center; line-height:120%!important } h3 { font-size:20px!important; text-align:center; line-height:120%!important } h1 a { font-size:30px!important } h2 a { font-size:26px!important } h3 a { font-size:20px!important } .es-menu td a { font-size:16px!important } .es-header-body p, .es-header-body ul li, .es-header-body ol li, .es-header-body a { font-size:16px!important } .es-footer-body p, .es-footer-body ul li, .es-footer-body ol li, .es-footer-body a { font-size:16px!important } .es-infoblock p, .es-infoblock ul li, .es-infoblock ol li, .es-infoblock a { font-size:12px!important } *[class="gmail-fix"] { display:none!important } .es-m-txt-c, .es-m-txt-c h1, .es-m-txt-c h2, .es-m-txt-c h3 { text-align:center!important } .es-m-txt-r, .es-m-txt-r h1, .es-m-txt-r h2, .es-m-txt-r h3 { text-align:right!important } .es-m-txt-l, .es-m-txt-l h1, .es-m-txt-l h2, .es-m-txt-l h3 { text-align:left!important } .es-m-txt-r img, .es-m-txt-c img, .es-m-txt-l img { display:inline!important } .es-button-border { display:block!important } a.es-button { font-size:20px!important; display:block!important; border-width:10px 0px 10px 0px!important } .es-btn-fw { border-width:10px 0px!important; text-align:center!important } .es-adaptive table, .es-btn-fw, .es-btn-fw-brdr, .es-left, .es-right { width:100%!important } .es-content table, .es-header table, .es-footer table, .es-content, .es-footer, .es-header { width:100%!important; max-width:600px!important } .es-adapt-td { display:block!important; width:100%!important } .adapt-img { width:100%!important; height:auto!important } .es-m-p0 { padding:0px!important } .es-m-p0r { padding-right:0px!important } .es-m-p0l { padding-left:0px!important } .es-m-p0t { padding-top:0px!important } .es-m-p0b { padding-bottom:0!important } .es-m-p20b { padding-bottom:20px!important } .es-mobile-hidden, .es-hidden { display:none!important } tr.es-desk-hidden, td.es-desk-hidden, table.es-desk-hidden { width:auto!important; overflow:visible!important; float:none!important; max-height:inherit!important; line-height:inherit!important } tr.es-desk-hidden { display:table-row!important } table.es-desk-hidden { display:table!important } td.es-desk-menu-hidden { display:table-cell!important } .es-menu td { width:1%!important } table.es-table-not-adapt, .esd-block-html table { width:auto!important } table.es-social { display:inline-block!important } table.es-social td { display:inline-block!important } }
                    </style> 
                     </head> 
                     <body style="width:100%;font-family:arial, 'helvetica neue', helvetica, sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;padding:0;Margin:0"> 
                      <div class="es-wrapper-color" style="background-color:#F6F6F6"> 
                       <!--[if gte mso 9]>
                                <v:background xmlns:v="urn:schemas-microsoft-com:vml" fill="t">
                                    <v:fill type="tile" color="#f6f6f6"></v:fill>
                                </v:background>
                            <![endif]--> 
                       <table class="es-wrapper" width="100%" cellspacing="0" cellpadding="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;padding:0;Margin:0;width:100%;height:100%;background-repeat:repeat;background-position:center top"> 
                         <tr style="border-collapse:collapse"> 
                          <td valign="top" style="padding:0;Margin:0"> 
                           <table cellpadding="0" cellspacing="0" class="es-content" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;table-layout:fixed !important;width:100%"> 
                             <tr style="border-collapse:collapse"> 
                              <td align="center" style="padding:0;Margin:0"> 
                               <table class="es-content-body" align="center" cellpadding="0" cellspacing="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;background-color:transparent;width:600px"> 
                                 <tr style="border-collapse:collapse"> 
                                  <td align="left" style="padding:0;Margin:0;padding-top:20px;padding-left:20px;padding-right:20px"> 
                                   <table cellpadding="0" cellspacing="0" width="100%" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                     <tr style="border-collapse:collapse"> 
                                      <td align="center" valign="top" style="padding:0;Margin:0;width:560px"> 
                                       <table cellpadding="0" cellspacing="0" width="100%" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:10px;Margin:0;font-size:0"> 
                                           <table border="0" width="100%" height="100%" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                             <tr style="border-collapse:collapse"> 
                                              <td style="padding:0;Margin:0;border-bottom:0px solid #CCCCCC;background:none;height:1px;width:100%;margin:0px"></td> 
                                             </tr> 
                                           </table></td> 
                                         </tr> 
                                       </table></td> 
                                     </tr> 
                                   </table></td> 
                                 </tr> 
                               </table></td> 
                             </tr> 
                           </table> 
                           <table class="es-content" cellspacing="0" cellpadding="0" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;table-layout:fixed !important;width:100%"> 
                             <tr style="border-collapse:collapse"> 
                              <td align="center" style="padding:0;Margin:0"> 
                               <table class="es-content-body" cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;background-color:#FFFFFF;width:600px"> 
                                 <tr style="border-collapse:collapse"> 
                                  <td align="left" style="padding:0;Margin:0;padding-top:30px;padding-left:35px;padding-right:35px"> 
                                   <table width="100%" cellspacing="0" cellpadding="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                     <tr style="border-collapse:collapse"> 
                                      <td valign="top" align="center" style="padding:0;Margin:0;width:530px"> 
                                       <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;font-size:0px"><img class="adapt-img" src="https://hvrqpw.stripocdn.email/content/guids/CABINET_01f7abfd58bcd55aa3d33c1a0cb1722d/images/48041601285025942.png" alt style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic" width="350"></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:20px;padding-bottom:20px;font-size:0"> 
                                           <table border="0" width="100%" height="100%" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                             <tr style="border-collapse:collapse"> 
                                              <td style="padding:0;Margin:0;border-bottom:2px solid #F2F2F2;background:none;height:1px;width:100%;margin:0px"></td> 
                                             </tr> 
                                           </table></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="left" style="padding:0;Margin:0;padding-bottom:5px;padding-left:10px;padding-right:10px"><h1 style="Margin:0;line-height:34px;mso-line-height-rule:exactly;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;font-size:28px;font-style:normal;font-weight:normal;color:#000000;text-align:left"><strong> Unsubscription Successful</strong></h1></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="left" style="Margin:0;padding-bottom:10px;padding-left:10px;padding-right:10px;padding-top:20px"><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:21px;color:#2A2E33">Per your request, your subscription has been cancelled. Your access will continue until the end of your current billing cycle.<br><br></p><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:21px;color:#2A2E33">Product: ${product}<br><br></p><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:21px;color:#2A2E33">If you need help or have any questions, please&nbsp;<strong><a target="_blank" style="-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;font-size:14px;text-decoration:underline;color:#F29D38" href="mailto:support@ratingsuite.com">contact us</a></strong></p><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:arial, 'helvetica neue', helvetica, sans-serif;line-height:21px;color:#2A2E33"><br></p></td> 
                                         </tr> 
                                       </table></td> 
                                     </tr> 
                                   </table></td> 
                                 </tr> 
                                 <tr style="border-collapse:collapse"> 
                                  <td align="left" bgcolor="#555555" style="padding:0;Margin:0;padding-top:20px;padding-left:20px;padding-right:20px;background-color:#555555"> 
                                   <table cellpadding="0" cellspacing="0" width="100%" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                     <tr style="border-collapse:collapse"> 
                                      <td align="center" valign="top" style="padding:0;Margin:0;width:560px"> 
                                       <table cellpadding="0" cellspacing="0" width="100%" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;font-size:0px"><img class="adapt-img" src="https://hvrqpw.stripocdn.email/content/guids/CABINET_01f7abfd58bcd55aa3d33c1a0cb1722d/images/82141601285215249.png" alt style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic" width="200"></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:10px;padding-bottom:10px;font-size:0"> 
                                           <table cellpadding="0" cellspacing="0" class="es-table-not-adapt es-social" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                             <tr style="border-collapse:collapse"> 
                                              <td align="center" valign="top" style="padding:0;Margin:0"><a target="_blank" href="https://twitter.com/ratingsuite" style="-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-family:arial, 'helvetica neue', helvetica, sans-serif;font-size:14px;text-decoration:underline;color:#1376C8"><img title="Twitter" src="https://hvrqpw.stripocdn.email/content/assets/img/social-icons/circle-white/twitter-circle-white.png" alt="Tw" width="32" style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic"></a></td> 
                                             </tr> 
                                           </table></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:10px;padding-bottom:10px"><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:16px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:24px;color:#FFFFFF">2020 © Ratingsuite</p></td> 
                                         </tr> 
                                       </table></td> 
                                     </tr> 
                                   </table></td> 
                                 </tr> 
                               </table></td> 
                             </tr> 
                           </table> 
                           <table class="es-footer" cellspacing="0" cellpadding="0" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;table-layout:fixed !important;width:100%;background-color:transparent;background-repeat:repeat;background-position:center top"> 
                             <tr style="border-collapse:collapse"> 
                              <td align="center" style="padding:0;Margin:0"> 
                               <table class="es-footer-body" cellspacing="0" cellpadding="0" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;background-color:transparent;width:600px"> 
                                 <tr style="border-collapse:collapse"> 
                                  <td align="left" style="padding:0;Margin:0;padding-top:20px;padding-left:20px;padding-right:20px"> 
                                   <table cellpadding="0" cellspacing="0" width="100%" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                     <tr style="border-collapse:collapse"> 
                                      <td align="center" valign="top" style="padding:0;Margin:0;width:560px"> 
                                       <table cellpadding="0" cellspacing="0" width="100%" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:5px;Margin:0;font-size:0"> 
                                           <table border="0" width="100%" height="100%" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                             <tr style="border-collapse:collapse"> 
                                              <td style="padding:0;Margin:0;border-bottom:0px solid #CCCCCC;background:none;height:1px;width:100%;margin:0px"></td> 
                                             </tr> 
                                           </table></td> 
                                         </tr> 
                                       </table></td> 
                                     </tr> 
                                   </table></td> 
                                 </tr> 
                               </table></td> 
                             </tr> 
                           </table></td> 
                         </tr> 
                       </table> 
                      </div>  
                     </body>
                    </html>`
                }
              },
            Subject: { Data: "Ratingsuite: Subscription has been cancelled!" }
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
    sql = "SELECT pp.plan, s.startDt, s.endDt, s.renewalDt, s.subscriptionStatus, upl.idUserPool, upl.type, upl.expiryDt, s.upid, \
            up.productAlias, upc.upcid, upc.channelName, upc.upcURL \
             FROM UserProduct up \
             JOIN Subscription s ON (up.upid = s.upid) \
             JOIN ProductPlan pp ON (pp.idProductPlan = s.idProductPlan) \
             JOIN UserPool upl ON (upl.idUserPool = s.idUserPool) \
             LEFT OUTER JOIN UserProductChannel upc ON (upc.upid = up.upid)\
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

// function updateUserMasterPOST() {
//     console.log("updateUserMasterPOST()");
//     sql = "UPDATE UserMaster \
//         SET userStatus = 'PROSPECT' \
//         WHERE userid = '" + userid + "'";
//     return executeQuery(sql);
// }

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

function getRecentUserProductChannel(upid, params) {
    sql = "SELECT upcid FROM UserProductChannel\
            WHERE upid = '" + upid + "' \
            AND channelName = '" + params.channelName + "' \
            AND upcURL = '" + params.channelURL + "'";

    return executeQuery(sql);
}

function createSubscriptionPOST(upid, idUserPool) {
    var post = {idProductPlan: 'PP5', upid: upid, idUserPool: idUserPool, subscriptionStatus: 'NEW'};
    sql = "INSERT INTO Subscription SET ?";
    return executePostQuery(sql, post);   
}

function insertUserPoolPOST(idUserPool) {
    var expiryDt = new Date();
    expiryDt.addDays(14);

    var post = {idUserPool: idUserPool, type: 'USER', userid: userid, expiryDt: expiryDt};
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
                Html: {                  
                  Charset: "UTF-8",
                  Data:
                    `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
                    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office" style="width:100%;font-family:arial, 'helvetica neue', helvetica, sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;padding:0;Margin:0">
                     <head> 
                      <meta charset="UTF-8"> 
                      <meta content="width=device-width, initial-scale=1" name="viewport"> 
                      <meta name="x-apple-disable-message-reformatting"> 
                      <meta http-equiv="X-UA-Compatible" content="IE=edge"> 
                      <meta content="telephone=no" name="format-detection"> 
                      <title>Subscription E-mail</title> 
                      <!--[if (mso 16)]>
                        <style type="text/css">
                        a {text-decoration: none;}
                        </style>
                        <![endif]--> 
                      <!--[if gte mso 9]><style>sup { font-size: 100% !important; }</style><![endif]--> 
                      <!--[if gte mso 9]>
                    <xml>
                        <o:OfficeDocumentSettings>
                        <o:AllowPNG></o:AllowPNG>
                        <o:PixelsPerInch>96</o:PixelsPerInch>
                        </o:OfficeDocumentSettings>
                    </xml>
                    <![endif]--> 
                      <!--[if !mso]><!-- --> 
                      <link href="https://fonts.googleapis.com/css?family=Open+Sans:400,400i,700,700i" rel="stylesheet"> 
                      <!--<![endif]--> 
                      <style type="text/css">
                    #outlook a {
                        padding:0;
                    }
                    .ExternalClass {
                        width:100%;
                    }
                    .ExternalClass,
                    .ExternalClass p,
                    .ExternalClass span,
                    .ExternalClass font,
                    .ExternalClass td,
                    .ExternalClass div {
                        line-height:100%;
                    }
                    .es-button {
                        mso-style-priority:100!important;
                        text-decoration:none!important;
                    }
                    a[x-apple-data-detectors] {
                        color:inherit!important;
                        text-decoration:none!important;
                        font-size:inherit!important;
                        font-family:inherit!important;
                        font-weight:inherit!important;
                        line-height:inherit!important;
                    }
                    .es-desk-hidden {
                        display:none;
                        float:left;
                        overflow:hidden;
                        width:0;
                        max-height:0;
                        line-height:0;
                        mso-hide:all;
                    }
                    @media only screen and (max-width:600px) {p, ul li, ol li, a { font-size:16px!important; line-height:150%!important } h1 { font-size:30px!important; text-align:center; line-height:120%!important } h2 { font-size:26px!important; text-align:center; line-height:120%!important } h3 { font-size:20px!important; text-align:center; line-height:120%!important } h1 a { font-size:30px!important } h2 a { font-size:26px!important } h3 a { font-size:20px!important } .es-menu td a { font-size:16px!important } .es-header-body p, .es-header-body ul li, .es-header-body ol li, .es-header-body a { font-size:16px!important } .es-footer-body p, .es-footer-body ul li, .es-footer-body ol li, .es-footer-body a { font-size:16px!important } .es-infoblock p, .es-infoblock ul li, .es-infoblock ol li, .es-infoblock a { font-size:12px!important } *[class="gmail-fix"] { display:none!important } .es-m-txt-c, .es-m-txt-c h1, .es-m-txt-c h2, .es-m-txt-c h3 { text-align:center!important } .es-m-txt-r, .es-m-txt-r h1, .es-m-txt-r h2, .es-m-txt-r h3 { text-align:right!important } .es-m-txt-l, .es-m-txt-l h1, .es-m-txt-l h2, .es-m-txt-l h3 { text-align:left!important } .es-m-txt-r img, .es-m-txt-c img, .es-m-txt-l img { display:inline!important } .es-button-border { display:block!important } a.es-button { font-size:20px!important; display:block!important; border-width:10px 0px 10px 0px!important } .es-btn-fw { border-width:10px 0px!important; text-align:center!important } .es-adaptive table, .es-btn-fw, .es-btn-fw-brdr, .es-left, .es-right { width:100%!important } .es-content table, .es-header table, .es-footer table, .es-content, .es-footer, .es-header { width:100%!important; max-width:600px!important } .es-adapt-td { display:block!important; width:100%!important } .adapt-img { width:100%!important; height:auto!important } .es-m-p0 { padding:0px!important } .es-m-p0r { padding-right:0px!important } .es-m-p0l { padding-left:0px!important } .es-m-p0t { padding-top:0px!important } .es-m-p0b { padding-bottom:0!important } .es-m-p20b { padding-bottom:20px!important } .es-mobile-hidden, .es-hidden { display:none!important } tr.es-desk-hidden, td.es-desk-hidden, table.es-desk-hidden { width:auto!important; overflow:visible!important; float:none!important; max-height:inherit!important; line-height:inherit!important } tr.es-desk-hidden { display:table-row!important } table.es-desk-hidden { display:table!important } td.es-desk-menu-hidden { display:table-cell!important } .es-menu td { width:1%!important } table.es-table-not-adapt, .esd-block-html table { width:auto!important } table.es-social { display:inline-block!important } table.es-social td { display:inline-block!important } }
                    </style> 
                     </head> 
                     <body style="width:100%;font-family:arial, 'helvetica neue', helvetica, sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;padding:0;Margin:0"> 
                      <div class="es-wrapper-color" style="background-color:#F6F6F6"> 
                       <!--[if gte mso 9]>
                                <v:background xmlns:v="urn:schemas-microsoft-com:vml" fill="t">
                                    <v:fill type="tile" color="#f6f6f6"></v:fill>
                                </v:background>
                            <![endif]--> 
                       <table class="es-wrapper" width="100%" cellspacing="0" cellpadding="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;padding:0;Margin:0;width:100%;height:100%;background-repeat:repeat;background-position:center top"> 
                         <tr style="border-collapse:collapse"> 
                          <td valign="top" style="padding:0;Margin:0"> 
                           <table cellpadding="0" cellspacing="0" class="es-content" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;table-layout:fixed !important;width:100%"> 
                             <tr style="border-collapse:collapse"> 
                              <td align="center" style="padding:0;Margin:0"> 
                               <table class="es-content-body" align="center" cellpadding="0" cellspacing="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;background-color:transparent;width:600px"> 
                                 <tr style="border-collapse:collapse"> 
                                  <td align="left" style="padding:0;Margin:0;padding-top:20px;padding-left:20px;padding-right:20px"> 
                                   <table cellpadding="0" cellspacing="0" width="100%" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                     <tr style="border-collapse:collapse"> 
                                      <td align="center" valign="top" style="padding:0;Margin:0;width:560px"> 
                                       <table cellpadding="0" cellspacing="0" width="100%" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:10px;Margin:0;font-size:0"> 
                                           <table border="0" width="100%" height="100%" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                             <tr style="border-collapse:collapse"> 
                                              <td style="padding:0;Margin:0;border-bottom:0px solid #CCCCCC;background:none;height:1px;width:100%;margin:0px"></td> 
                                             </tr> 
                                           </table></td> 
                                         </tr> 
                                       </table></td> 
                                     </tr> 
                                   </table></td> 
                                 </tr> 
                               </table></td> 
                             </tr> 
                           </table> 
                           <table class="es-content" cellspacing="0" cellpadding="0" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;table-layout:fixed !important;width:100%"> 
                             <tr style="border-collapse:collapse"> 
                              <td align="center" style="padding:0;Margin:0"> 
                               <table class="es-content-body" cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;background-color:#FFFFFF;width:600px"> 
                                 <tr style="border-collapse:collapse"> 
                                  <td align="left" style="padding:0;Margin:0;padding-top:30px;padding-left:35px;padding-right:35px"> 
                                   <table width="100%" cellspacing="0" cellpadding="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                     <tr style="border-collapse:collapse"> 
                                      <td valign="top" align="center" style="padding:0;Margin:0;width:530px"> 
                                       <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;font-size:0px"><img class="adapt-img" src="https://hvrqpw.stripocdn.email/content/guids/CABINET_01f7abfd58bcd55aa3d33c1a0cb1722d/images/48041601285025942.png" alt style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic" width="350"></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:20px;padding-bottom:20px;font-size:0"> 
                                           <table border="0" width="100%" height="100%" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                             <tr style="border-collapse:collapse"> 
                                              <td style="padding:0;Margin:0;border-bottom:2px solid #F2F2F2;background:none;height:1px;width:100%;margin:0px"></td> 
                                             </tr> 
                                           </table></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="left" style="padding:0;Margin:0;padding-bottom:5px;padding-left:10px;padding-right:10px"><h1 style="Margin:0;line-height:34px;mso-line-height-rule:exactly;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;font-size:28px;font-style:normal;font-weight:normal;color:#000000;text-align:left"><strong>Subscription Confirmation!</strong></h1></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="left" style="Margin:0;padding-bottom:10px;padding-left:10px;padding-right:10px;padding-top:20px"><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:21px;color:#2A2E33">You are subscribed to Sandbox.<br><br></p><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:21px;color:#2A2E33">We have pre-loaded few products for new users to get first hand experience of the platform. Your access to Sandbox will expire in 14 days.<br><br></p><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:21px;color:#2A2E33">If you need help or have any questions, please&nbsp;<strong><a target="_blank" style="-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;font-size:14px;text-decoration:underline;color:#F29D38" href="mailto:support@ratingsuite.com">contact us</a></strong></p><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:arial, 'helvetica neue', helvetica, sans-serif;line-height:21px;color:#2A2E33"><br></p></td> 
                                         </tr> 
                                       </table></td> 
                                     </tr> 
                                   </table></td> 
                                 </tr> 
                                 <tr style="border-collapse:collapse"> 
                                  <td align="left" bgcolor="#555555" style="padding:0;Margin:0;padding-top:20px;padding-left:20px;padding-right:20px;background-color:#555555"> 
                                   <table cellpadding="0" cellspacing="0" width="100%" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                     <tr style="border-collapse:collapse"> 
                                      <td align="center" valign="top" style="padding:0;Margin:0;width:560px"> 
                                       <table cellpadding="0" cellspacing="0" width="100%" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;font-size:0px"><img class="adapt-img" src="https://hvrqpw.stripocdn.email/content/guids/CABINET_01f7abfd58bcd55aa3d33c1a0cb1722d/images/82141601285215249.png" alt style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic" width="200"></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:10px;padding-bottom:10px;font-size:0"> 
                                           <table cellpadding="0" cellspacing="0" class="es-table-not-adapt es-social" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                             <tr style="border-collapse:collapse"> 
                                              <td align="center" valign="top" style="padding:0;Margin:0"><a target="_blank" href="https://twitter.com/ratingsuite" style="-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-family:arial, 'helvetica neue', helvetica, sans-serif;font-size:14px;text-decoration:underline;color:#1376C8"><img title="Twitter" src="https://hvrqpw.stripocdn.email/content/assets/img/social-icons/circle-white/twitter-circle-white.png" alt="Tw" width="32" style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic"></a></td> 
                                             </tr> 
                                           </table></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:10px;padding-bottom:10px"><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:16px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:24px;color:#FFFFFF">2020 © Ratingsuite</p></td> 
                                         </tr> 
                                       </table></td> 
                                     </tr> 
                                   </table></td> 
                                 </tr> 
                               </table></td> 
                             </tr> 
                           </table> 
                           <table class="es-footer" cellspacing="0" cellpadding="0" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;table-layout:fixed !important;width:100%;background-color:transparent;background-repeat:repeat;background-position:center top"> 
                             <tr style="border-collapse:collapse"> 
                              <td align="center" style="padding:0;Margin:0"> 
                               <table class="es-footer-body" cellspacing="0" cellpadding="0" align="center" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;background-color:transparent;width:600px"> 
                                 <tr style="border-collapse:collapse"> 
                                  <td align="left" style="padding:0;Margin:0;padding-top:20px;padding-left:20px;padding-right:20px"> 
                                   <table cellpadding="0" cellspacing="0" width="100%" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                     <tr style="border-collapse:collapse"> 
                                      <td align="center" valign="top" style="padding:0;Margin:0;width:560px"> 
                                       <table cellpadding="0" cellspacing="0" width="100%" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:5px;Margin:0;font-size:0"> 
                                           <table border="0" width="100%" height="100%" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                             <tr style="border-collapse:collapse"> 
                                              <td style="padding:0;Margin:0;border-bottom:0px solid #CCCCCC;background:none;height:1px;width:100%;margin:0px"></td> 
                                             </tr> 
                                           </table></td> 
                                         </tr> 
                                       </table></td> 
                                     </tr> 
                                   </table></td> 
                                 </tr> 
                               </table></td> 
                             </tr> 
                           </table></td> 
                         </tr> 
                       </table> 
                      </div>  
                     </body>
                    </html>`
                }
            },
            Subject: { Data: "Ratingsuite: You are subscribed to Sandbox!" }
        },
        Source: sourceEmail
    };

    return param;
}

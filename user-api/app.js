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

    if (isEmpty(event.requestContext.authorizer.claims.username)) {
      userid = event.requestContext.authorizer.claims["cognito:username"];
    } else {
      userid = event.requestContext.authorizer.claims.username;
    }

    if (userid == null) {
        throw new Error("Username is missing. Not authenticated.");
    }

    let body;
    let statusCode = '200';

    const headers = {
        "Access-Control-Allow-Credentials" : true,
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
                        sql = "SELECT um.userid, um.name, um.userType, um.organization, um.userStatus, nt.desc,n.flag \
                                FROM UserMaster um \
                                LEFT OUTER JOIN Notification n on um.userid = n.userid and n.notificationTypeID = 1 \
                                LEFT OUTER JOIN NotificationType nt on n.notificationTypeID = nt.notificationTypeID \
                                WHERE um.userid = '" + userid + "'";
                        executeQuery(sql).then(resolve, reject);
                    break;
    
                    case 'POST': 
                        sql = "SELECT * FROM UserMaster where userid = '" + userid + "'";
                        executeQuery(sql).then(function(data) {

                          if (isEmpty(data)) {                            
                              insertUserMaster(fname, forg).then(async function() {
                                await insertNotification();
                                await sendEmail(generateWelcomeParam()).then(resolve, reject);
                              }, reject);

                          } else {
                              sql = "SELECT um.userid, um.name, um.userType, um.organization, um.userStatus, nt.desc,n.flag \
                                  FROM UserMaster um \
                                  LEFT OUTER JOIN Notification n on um.userid = n.userid and n.notificationTypeID = 1 \
                                  LEFT OUTER JOIN NotificationType nt on n.notificationTypeID = nt.notificationTypeID \
                                  WHERE um.userid = '" + userid + "'";

                              executeQuery(sql).then(resolve, reject);
                          }

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
                                    sendEmail(generateGoodbyeParam()).then(resolve, reject);                                          
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

function isEmpty(data) {
  if (data == undefined || data == null || data.length == 0) {
      return true;
  }
  return false;
}


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
            } else {
                console.log("SQL Result: ", result[0] == undefined ? result : result[0]);
                resolve(result);
            }            
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

function generateWelcomeParam() {
    var param = {
        Destination: {
            ToAddresses: [userid]
        },
        Message: {

            Body: {
                Html: {
                  // HTML Format of the email
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
                      <title>Welcome Email</title> 
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
                                  <td align="left" style="padding:30px;Margin:0"> 
                                   <table width="100%" cellspacing="0" cellpadding="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                     <tr style="border-collapse:collapse"> 
                                      <td valign="top" align="center" style="padding:0;Margin:0;width:540px"> 
                                       <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;font-size:0px"><img class="adapt-img" src="https://hvrqpw.stripocdn.email/content/guids/CABINET_1c0a6da3d47aca8a15d8a920458537da/images/48041601285025942.png" alt style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic" width="350"></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:20px;Margin:0;font-size:0"> 
                                           <table border="0" width="100%" height="100%" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                             <tr style="border-collapse:collapse"> 
                                              <td style="padding:0;Margin:0;border-bottom:2px solid #F2F2F2;background:none;height:1px;width:100%;margin:0px"></td> 
                                             </tr> 
                                           </table></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:5px;padding-bottom:10px"><h1 style="Margin:0;line-height:31px;mso-line-height-rule:exactly;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;font-size:26px;font-style:normal;font-weight:normal;color:#000000;text-align:center"><strong>Thanks for signing up!</strong></h1></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:5px;padding-bottom:10px"><h1 style="Margin:0;line-height:24px;mso-line-height-rule:exactly;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;font-size:20px;font-style:normal;font-weight:normal;color:#000000;text-align:center"><strong>We're excited to have you onboard.</strong></h1></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:10px;padding-bottom:10px"><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:21px;color:#2A2E33">To get you started, here's a quick intro to Ratingsuite</p></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:10px;padding-bottom:10px"><span class="es-button-border" style="border-style:solid;border-color:#2CB543;background:#F29D38;border-width:0px;display:inline-block;border-radius:6px;width:auto"><a href="https://www.youtube.com/" class="es-button" target="_blank" style="mso-style-priority:100 !important;text-decoration:none;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;font-size:18px;color:#FFFFFF;border-style:solid;border-color:#F29D38;border-width:10px 40px;display:inline-block;background:#F29D38;border-radius:6px;font-weight:normal;font-style:normal;line-height:22px;width:auto;text-align:center">Watch Video</a></span></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="Margin:0;padding-left:5px;padding-right:5px;padding-top:20px;padding-bottom:20px"><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:21px;color:#2A2E33">Ratingsuite provides a single dashboard to analyze product reviews from multiple e-commerce sites. You can set up products, channels and analyze the reviews in the dashboard.</p></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:10px;padding-bottom:10px"><span class="es-button-border" style="border-style:solid;border-color:#2CB543;background:#F29D38;border-width:0px;display:inline-block;border-radius:6px;width:auto"><a href="http://www.ratingsuite.com/" class="es-button" target="_blank" style="mso-style-priority:100 !important;text-decoration:none;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;font-size:18px;color:#FFFFFF;border-style:solid;border-color:#F29D38;border-width:10px 40px;display:inline-block;background:#F29D38;border-radius:6px;font-weight:normal;font-style:normal;line-height:22px;width:auto;text-align:center">Go to ratingsuite</a></span></td> 
                                         </tr> 
                                         <tr style="border-collapse:collapse"> 
                                          <td align="center" style="padding:0;Margin:0;padding-top:15px"><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:21px;color:#2A2E33">If you have any questions, please let us know at</p><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;line-height:21px;color:#2A2E33"><strong><a href="#" target="_blank" style="-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;font-size:14px;text-decoration:none;color:#F29D38">support@ratingsuite.com</a></strong></p></td> 
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
                                          <td align="center" style="padding:0;Margin:0;font-size:0px"><img class="adapt-img" src="https://hvrqpw.stripocdn.email/content/guids/CABINET_1c0a6da3d47aca8a15d8a920458537da/images/82141601285215249.png" alt style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic" width="200"></td> 
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

            Subject: { Data: "Welcome to Ratingsuite!" }
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
                Html: {
                    // HTML Format of the email
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
                        <title>Deactivation Email</title> 
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
                                    <td align="left" style="Margin:0;padding-top:30px;padding-bottom:30px;padding-left:35px;padding-right:35px"> 
                                     <table width="100%" cellspacing="0" cellpadding="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                       <tr style="border-collapse:collapse"> 
                                        <td valign="top" align="center" style="padding:0;Margin:0;width:530px"> 
                                         <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px"> 
                                           <tr style="border-collapse:collapse"> 
                                            <td align="center" style="padding:0;Margin:0;font-size:0px"><img class="adapt-img" src="https://hvrqpw.stripocdn.email/content/guids/CABINET_a06eca429a87564884a83a44b1c79140/images/48041601285025942.png" alt style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic" width="350"></td> 
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
                                            <td align="left" style="padding:0;Margin:0;padding-bottom:5px;padding-left:10px;padding-right:10px"><h1 style="Margin:0;line-height:34px;mso-line-height-rule:exactly;font-family:'open sans', 'helvetica neue', helvetica, arial, sans-serif;font-size:28px;font-style:normal;font-weight:normal;color:#000000;text-align:left"><strong>We’re sad to see you go!</strong></h1></td> 
                                           </tr> 
                                           <tr style="border-collapse:collapse"> 
                                            <td align="left" style="Margin:0;padding-bottom:10px;padding-left:10px;padding-right:10px;padding-top:20px"><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:arial, 'helvetica neue', helvetica, sans-serif;line-height:21px;color:#333333">Your account has been deactivated and all your information has been deleted from our system.</p><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:arial, 'helvetica neue', helvetica, sans-serif;line-height:21px;color:#333333"><br></p><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:arial, 'helvetica neue', helvetica, sans-serif;line-height:21px;color:#333333">We hope to see you back on Ratingsuite soon!</p><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:arial, 'helvetica neue', helvetica, sans-serif;line-height:21px;color:#333333"><br></p><p style="Margin:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-size:14px;font-family:arial, 'helvetica neue', helvetica, sans-serif;line-height:21px;color:#333333">If you have any feedback or questions, please&nbsp;<strong><a href="mailto:support@ratingsuite.com" target="_blank" style="-webkit-text-size-adjust:none;-ms-text-size-adjust:none;mso-line-height-rule:exactly;font-family:arial, 'helvetica neue', helvetica, sans-serif;font-size:14px;text-decoration:underline;color:#F29D38">contact us</a></strong></p></td> 
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
                                            <td align="center" style="padding:0;Margin:0;font-size:0px"><img class="adapt-img" src="https://hvrqpw.stripocdn.email/content/guids/CABINET_a06eca429a87564884a83a44b1c79140/images/82141601285215249.png" alt style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic" width="200"></td> 
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
            Subject: { Data: "We’re sad to see you go!" }
        },
        Source: sourceEmail
    };

    return param;
}

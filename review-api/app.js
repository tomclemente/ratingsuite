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

var userPoolData = [];
var userMasterData;
var getPromises = [];
var productReviewData = [];
var userChannelPreferenceData = [];
var userPreferenceData = [];
var userProductPreferenceData = [];
var userFilterPreferenceData;
var filterData = [];

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

                        getPromises.push(getUserMaster());
                        getPromises.push(getUserFilterPreference());
                        getPromises.push(getUserPool()); // Jeet - add option for more than one userpool
                        getPromises.push(getUserChannelPreference()); 
                        getPromises.push(getUserProductPreference()); 

                        Promise.all(getPromises).then(function() {
                            if (userMasterData.userStatus != 'CUSTOMER' && userMasterData.userStatus != 'BETA') {
                                throw new Error("Not Authorized.");
                            }

                            if (params == undefined || params == null) {
                                if (userFilterPreferenceData != null || userFilterPreferenceData != undefined) {
                                    getProductReview(userChannelPreferenceData, userProductPreferenceData).then(function(data) {
                                        if (data != undefined && data != null) {
                                            data.Filters = filterData;                                                
                                        }
                                        resolve(data);
                                    }, reject);

                                } else { //no user preference
                                    getUpID().then(function(data) { 
                                        getDefaultProductReviews(data).then(function(data) {
                                            if (data != undefined && data != null) {
                                                data.Filters = filterData;                                                
                                            }
                                            resolve(data);   
                                        }, reject);
                                    }, reject);
                                }

                            } else {
                                getProductReviewsWithParams(params).then(function(data) {
                                    if (data != undefined && data != null) {
                                        data.Filters = filterData;                                                
                                    }
                                    resolve(data);                                   
                                }, reject);
                            }
                        }, reject).catch(err => reject({ statusCode: 500, body: err.message }));;

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

function getUserMaster() {
    sql = "SELECT * FROM UserMaster WHERE userid = '" + userid + "'";  

    return executeQuery(sql).then(function(result) {
        userMasterData = result[0];
        console.log("UserMasterData: ", userMasterData);
    });
}

function getUserFilterPreference() {
    sql = "SELECT * FROM UserFilterPreference \
            WHERE preferenceType = 'REVIEW' \
            AND userid = '" + userid + "'";

    return executeQuery(sql).then(function(result) {
        userFilterPreferenceData = result[0];
        console.log("userFilterPreferenceData: ", userFilterPreferenceData);
    });
}

// Jeet - user can have upto 2. capture more than one userpool
function getUserPool() {
    sql = "SELECT idUserPool FROM UserPool WHERE userid = '" + userid + "'";
    
    return executeQuery(sql).then(function(result) {
        userPoolData = result;
        console.log("userPoolData: ", userPoolData);
    });
}

function getUserChannelPreference() {
    sql = "SELECT upcid FROM UserChannelPreference \
            WHERE preferenceType = 'REVIEW' \
            AND userid = '" + userid + "'";

    return executeQuery(sql).then(function(result) {
        if (!isEmpty(result)) {
            userChannelPreferenceData = result;
        }
       
        console.log("userChannelPreferenceData: ", userChannelPreferenceData);
    });
}

function getUserProductPreference() {    
    sql = "SELECT upid FROM UserProductPreference \
            WHERE preferenceType = 'REVIEW' \
            AND userid = '" + userid + "'";
        

    return executeQuery(sql).then(function(result) {
        if (!isEmpty(result)) {
            userProductPreferenceData = result;
        }
        console.log("userProductPreferenceData: ", userProductPreferenceData);
    });
}

function getProductReview(upcidPref, upidPref) {
    let filter = createFilter();
    let upcidlist = "'";
    let upidlist = "'";
    let userpoollist = "'";
    var x = 0;

    let arr1 = new Array();
    for (x = 0; x < upcidPref.length; x++) {
        arr1.push(upcidPref[x].upcid);
    }

    let arr2 = new Array();
    for (x = 0; x < upidPref.length; x++) {
        arr2.push(upidPref[x].upid);
    }

    let arr3 = new Array();
    for (x = 0; x < userPoolData.length; x++) {
        arr3.push(userPoolData[x].idUserPool);
    }

    upcidlist += arr1.join("\',\'");
    upcidlist += "'";

    upidlist += arr2.join("\',\'");
    upidlist += "'";

    userpoollist += arr3.join("\',\'");
    userpoollist += "'";

    // Jeet - change query to take multiple iduserpool

    sql = "Select s.upid,up.productAlias,upc.upcid,upc.channelName, pr.reviewID, \
            pr.reviewTitle, pr.reviewBody, pr.reviewUser, pr.reviewUserID, \
            pr.verifiedPurchase, pr.reviewDate, pr.reviewRating, pr.reviewSentiment, \
            pr.reviewRelevance, pr.positiveVotes, pr.negativeVotes, pr.totalVotes \
                FROM ProductReview pr \
                    JOIN ProductChannel pc ON pr.pcid = pc.pcid AND pc.status = 'ACTIVE' \
                    JOIN ProductChannelMapping pcm ON pc.pcid = pcm.pcid \
                    JOIN UserProductChannel upc ON pcm.upcid = upc.upcid AND upc.status = 'ACTIVE' \
                    JOIN UserProduct up ON upc.upid = up.upid AND up.status = 'ACTIVE' \
                    JOIN Subscription s ON up.upid = s.upid AND s.idUserPool in (" + userpoollist + ") \
                WHERE s.upid in (" + upidlist + ") \
                AND s.subscriptionStatus = ACTIVE AND upcid in (" + upcidlist + ") " + filter + "";
            
    return executeQuery(sql).then(function(result) {
        productReviewData = result;
        console.log("productReviewData: ", productReviewData);
    });
}

function createFilter() {

    let cond = "";
    let ufp = userFilterPreferenceData;
    filterData = new Array();

    if (ufp.rating != null && ufp.rating != 'ALL') {
        filterData.push({ "rating" : ufp.rating });
        cond = cond.concat(" AND pr.reviewRating = '" + ufp.rating + "'");
    }

    if (ufp.sentiment != null && ufp.sentiment != 'ALL') {
        filterData.push({ "sentiment" : ufp.sentiment });
        cond = cond.concat(" AND pr.reviewSentiment = '" + ufp.sentiment + "'");
    }

    if (ufp.time != null && ufp.time != 'Range') {
        let time = new Date() - ufp.time;
        filterData.push({ "time" : ufp.time });
        cond = cond.concat(" AND pr.reviewDate >= '" + time + "'");

    } else {
        if (ufp.timeFrom != null) {
            filterData.push({ "timeFrom" : ufp.timeFrom });
            cond = cond.concat(" AND pr.reviewDate >= '" + ufp.timeFrom + "'");
        }
    
        if (ufp.timeTo != null) {
            filterData.push({ "timeTo" : ufp.timeTo });
            cond = cond.concat(" AND pr.reviewDate <= '" + ufp.timeTo + "'");
        }
    }

    //SORTING
    if (ufp.sort == 'highest rated') {
        cond = cond.concat(" ORDER BY pr.reviewRating DESC");
    } else if (ufp.sort == 'lowest rated') {
        cond = cond.concat(" ORDER BY pr.reviewRating ASC");
    } else if (ufp.sort == 'oldest reviews') {
        cond = cond.concat(" ORDER BY pr.reviewDate ASC");
    }  else { //default is recent reviews
        cond = cond.concat(" ORDER BY pr.reviewDate DESC");
    }

    filterData.push({ "sortby" : ufp.sort });

    console.log("createFilter: ", cond);

    return cond;
}

function getUpID() {
    let userpoollist = "'";
    
    let arr = new Array();
    for (var x = 0; x < userPoolData.length; x++) {
        arr.push(userPoolData[x].idUserPool);
    }

    userpoollist += arr.join("\',\'");
    userpoollist += "'";

    console.log("userpoollist: ", userpoollist);

    sql = "SELECT up.upid \
            FROM UserProduct up \
            WHERE up.upid IN (SELECT upid FROM Subscription \
                    WHERE subscriptionStatus = 'ACTIVE' AND idUserPool in (" + userpoollist + ")) \
            AND up.status = 'ACTIVE' \
            ORDER by up.productAlias DESC \
            LIMIT 1";
    return executeQuery(sql);
}

function getDefaultProductReviews(upid) {
    let filter = createDefaultFilter();

    console.log("getDefaultProductReviews upid: ", upid);

    let arr = new Array();
    for (var x = 0; x < upid.length; x++) {
        arr.push(upid[x].upid);
    }
 
    let upidlist = "'";

    upidlist += arr.join("\',\'");
    upidlist += "'";

    filterData.push({ "upid" : upidlist });

    console.log("getDefaultProductReviews upidlist: ", upidlist);

    sql = "SELECT up.upid,up.productAlias,upc.upcid,upc.channelName, \
                pr.reviewID, pr.reviewTitle, pr.reviewBody, pr.reviewUser, \
                pr.reviewUserID, pr.verifiedPurchase, pr.reviewDate, \
                pr.reviewRating, pr.reviewSentiment, pr.reviewRelevance, \
                pr.positiveVotes, pr.negativeVotes, pr.totalVotes \
            FROM ProductReview pr \
            JOIN ProductChannel pc ON pr.pcid = pc.pcid AND pc.status = 'ACTIVE' \
            JOIN ProductChannelMapping pcm ON pc.pcid = pcm.pcid \
            JOIN UserProductChannel upc ON pcm.upcid = upc.upcid AND upc.status = 'ACTIVE' AND upc.upid = upid \
            JOIN UserProduct up ON upc.upid in (" + upidlist + ") \
            WHERE " + filter + " ";
            
    return executeQuery(sql).then(function(result) {
        productReviewData = result;

        filterData.push({ "productAlias" : productReviewData["productAlias"] });
        filterData.push({ "upcid" : productReviewData["upcid"] });
        filterData.push({ "channelName" : productReviewData["channelName"] });

        console.log("productReviewData: ", productReviewData);
    });
}

function createDefaultFilter() {
    let cond = "";
    let prev7days = new Date();
    var pad = function(num) { return ('00'+num).slice(-2) };

    prev7days.setDate(prev7days.getDate() - 7);

    prev7days = prev7days.getUTCFullYear()        + '-' +
        pad(prev7days.getUTCMonth() + 1) + '-' +
        pad(prev7days.getUTCDate())       + ' ' +
        pad(prev7days.getUTCHours())      + ':' +
        pad(prev7days.getUTCMinutes())    + ':' +
        pad(prev7days.getUTCSeconds());       

    console.log("prev7days: ", prev7days);
    
    filterData = new Array();
    
    cond = cond.concat(" pr.reviewDate >= '" + prev7days + "' ");
    cond = cond.concat(" ORDER BY pr.reviewDate DESC ");
    cond = cond.concat(" LIMIT 20 ");
    
    // Jeet - return upid, productAlias, upcid, channelName
    // Jeet - time : "past 7 days"
    // Jeet - sentiment : "All"
    // Jeet - rating : "All"

    filterData.push({ "time" : "7" });
    filterData.push({ "sentiment" : "All"});
    filterData.push({ "rating" : "All"});
    filterData.push({ "sortby" : "recent reviews"});
    filterData.push({ "limit" : "20" });

    console.log("createDefaultFilter: ", cond);

    return cond;
}

function getProductReviewsWithParams(params) {
    let filter = createParamFilters(params);

    let upclist = "'";
    let userpoollist = "'";
    var x = 0;

    let arr1 = new Array();
    for (x = 0; x < userChannelPreferenceData.length; x++) {
        arr1.push(userChannelPreferenceData[x].upcid);
    }

    let arr2 = new Array();
    for (x = 0; x < userPoolData.length; x++) {
        arr2.push(userPoolData[x].idUserPool);
    }
    
    upclist += arr1.join("\',\'");
    upclist += "'";

    userpoollist += arr2.join("\',\'");
    userpoollist += "'";

    sql = "Select s.upid,up.productAlias,upc.upcid,upc.channelName, \
                pr.reviewID, pr.reviewTitle, pr.reviewBody, pr.reviewUser, \
                pr.reviewUserID, pr.verifiedPurchase, pr.reviewDate, \
                pr.reviewRating, pr.reviewSentiment, pr.reviewRelevance, \
                pr.positiveVotes, pr.negativeVotes, pr.totalVotes \
            FROM ProductReview pr \
            JOIN ProductChannel pc ON pr.pcid = pc.pcid AND pc.status = 'ACTIVE' \
            JOIN ProductChannelMapping pcm ON pc.pcid = pcm.pcid \
            JOIN UserProductChannel upc ON pcm.upcid = upc.upcid AND upc.status = 'ACTIVE' \
            JOIN UserProduct up ON upc.upid = up.upid AND up.status = 'ACTIVE' \
            JOIN Subscription s ON up.upid = s.upid AND s.idUserPool in (" + userpoollist + ") \
            WHERE up.upid = '" + params.upid + "' \
            AND s.subscriptionStatus = ACTIVE AND upc.upcid in (" + upclist + ") " + filter + " ";
            
    return executeQuery(sql).then(function(result) {
        productReviewData = result;
        console.log("productReviewData: ", productReviewData);
    });
}

function createParamFilters(params) {
    var cond = "";
    filterData = params;
    console.log("createParamFilters params: ", params);

    if (params.time != null && params.time != 'Range') {
        let time = new Date() - params.time;
        cond = cond.concat(" AND pr.reviewDate >= '" + time + "'");

    } else {
        if (params.timeFrom != null) {
            cond = cond.concat(" AND pr.reviewDate >= '" + params.timeFrom + "'");
        }
    
        if (params.timeTo != null) {
            cond = cond.concat(" AND pr.reviewDate <= '" + params.timeTo + "'");
        }
    }

 
    if (params.rating != null && params.rating != 'ALL') {
        cond = cond.concat(" AND pr.reviewRating = '" + params.rating + "'");
    }

    if (params.sentiment != null && params.sentiment != 'ALL') {
        cond =  cond.concat(" AND pr.reviewSentiment = '" + params.sentiment + "'");
    }

    if (params.searchTerm != null) {
        let keyword = params.searchTerm.toLowerCase();
        cond = cond.concat(" AND LOWER(pr.reviewBody) LIKE '%" + keyword + "%' ");
    }

    //SORTING
    if (params.sortby == 'highest rated') {
        cond = cond.concat(" ORDER BY pr.reviewRating DESC");
    } else if (params.sortby == 'lowest rated') {
        cond = cond.concat(" ORDER BY pr.reviewRating ASC");
    } else if (params.sortby == 'oldest reviews') {
        cond = cond.concat(" ORDER BY pr.reviewDate ASC");
    }  else { //default is recent reviews
        cond = cond.concat(" ORDER BY pr.reviewDate DESC");
    }

    if (params.limit != null) {
        cond = cond.concat(" LIMIT '" + params.limit + "'");
    }

    if (params.offset != null) {
        cond = cond.concat(" OFFSET '" + params.offset + "'");
    }

    console.log("createParamFilters: ", cond);

    return cond;
}

function getCognitoUser() {
    const cognito = new AWS.CognitoIdentityServiceProvider({ region: process.env.REGION });

    return cognito.adminGetUser({
        UserPoolId: process.env.COGNITO_POOLID,
        Username: userid, 
        
    }).promise();
}
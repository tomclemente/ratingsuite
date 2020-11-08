var mysql = require('mysql');
var AWS = require('aws-sdk');

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
var getPromises = [];
var productReviewData = [];
var userChannelPreferenceData = [];
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
                    case 'POST':

                        getPromises.push(getUserMaster());
                        getPromises.push(getUserFilterPreference());
                        getPromises.push(getUserPool());
                        getPromises.push(getUserChannelPreference());

                        Promise.all(getPromises).then(function() {
                            if (userMasterData.userStatus != 'CUSTOMER' && userMasterData.status != 'BETA') {
                                throw new Error("Not Authorized.");
                            }

                            if (params == undefined || params == null) {
                                if (userFilterPreferenceData != null || userFilterPreferenceData != undefined) {
                                    getProductReview(userPoolData.idUserPool, userChannelPreferenceData).then(function(data) {
                                        if (data != undefined && data != null) {
                                            data.Filters = filterData;                                                
                                        }
                                        resolve(data);
                                    }, reject);

                                } else { //no user preference
                                    getUpID().then(function(data) {
                                        let upid = data[0].upid;
                                        getDefaultProductReviews(upid).then(function(data) {
                                            if (data != undefined && data != null) {
                                                data.Filters = filterData;                                                
                                            }
                                            resolve(data);   
                                        }, reject);
                                    }, reject);
                                }

                            } else {
                                getProductReviewsWithParams(userPoolData.idUserPool, params).then(function(data) {
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
        body = err;
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

function getUserPool() {
    sql = "SELECT * FROM UserPool WHERE userid = '" + userid + "'";

    return executeQuery(sql).then(function(result) {
        userPoolData = result[0];
        console.log("userPoolData: ", userPoolData);
    });
}

function getUserChannelPreference() {
    sql = "SELECT * FROM UserChannelPreference \
            WHERE preferenceType = 'REVIEW' \
            AND userid = '" + userid + "'";

    return executeQuery(sql).then(function(result) {
        userChannelPreferenceData = result;
        console.log("userChannelPreferenceData: ", userChannelPreferenceData);
    });
}

function getProductReview(idUserPool, upcidPref) {
    let filter = createFilter();
    let upcidlist = "'";
    upcidlist += upcidPref.join("\',\'");
    upcidlist += "'";

    sql = "Select s.upid,up.productAlias,upc.upcid,upc.channelName, pr.reviewID, \
            pr.reviewTitle, pr.reviewBody, pr.reviewUser, pr.reviewUserID, \
            pr.verifiedPurchase, pr.reviewDate, pr.reviewRating, pr.reviewSentiment, \
            pr.reviewRelevance, pr.positiveVotes, pr.negativeVotes, pr.totalVotes \
                FROM ProductReview pr \
                    JOIN ProductChannel pc ON pr.pcid = pc.pcid AND pc.status = 'ACTIVE' \
                    JOIN ProductChannelMapping pcm ON pc.pcid = pcm.pcid \
                    JOIN UserProductChannel upc ON pcm.upcid = upc.upcid AND upc.status = 'ACTIVE' \
                    JOIN UserProduct up ON upc.upid = up.upid AND up.status = 'ACTIVE' \
                    JOIN Subscription s ON up.upid = s.upid AND s.idUserPool = '" + idUserPool + "' \
                WHERE upcid in '" + upcidlist + "' " + filter + "";
                //removed s.status = ACTIVE, no status column in Subscription
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
        cond = cond.concat(" AND reviewRating = '" + ufp.rating + "'");
    }

    if (ufp.sentiment != null && ufp.sentiment != 'ALL') {
        filterData.push({ "sentiment" : ufp.sentiment });
        cond = cond.concat(" AND reviewSentiment = '" + ufp.sentiment + "'");
    }

    if (ufp.time != null && ufp.time != 'ALL') { //TODO for time-range
        let time = new Date() - ufp.time; //TO TEST
        filterData.push({ "time" : ufp.time });
        cond = cond.concat(" AND reviewDate >= '" + time + "'");

    } else {
        if (ufp.timeFrom != null) {
            filterData.push({ "timeFrom" : ufp.timeFrom });
            cond = cond.concat(" AND reviewDate >= '" + ufp.timeFrom + "'");
        }
    
        if (ufp.timeTo != null) {
            filterData.push({ "timeTo" : ufp.timeTo });
            cond = cond.concat(" AND reviewDate <= '" + ufp.timeTo + "'");
        }
    }

    //SORTING
    if (ufp.sort == 'highest rated') {
        cond = cond.concat(" ORDER BY reviewRating DESC");
    } else if (ufp.sort == 'lowest rated') {
        cond = cond.concat(" ORDER BY reviewRating ASC");
    } else if (ufp.sort == 'oldest reviews') {
        cond = cond.concat(" ORDER BY reviewDate ASC");
    }  else { //default is recent reviews
        cond = cond.concat(" ORDER BY reviewDate DESC");
    }

    filterData.push({ "sortby" : ufp.sort });

    console.log("createFilter: ", cond);

    return cond;
}

function getUpID() {
    sql = "SELECT up.upid \
            FROM UserProduct up \
            WHERE up.upid IN (SELECT upid FROM Subscription \
                    WHERE subscriptionStatus = 'ACTIVE' AND idUserPool = '" + idUserPool + "' \
            AND up.status = 'ACTIVE' \
            ORDER by up.productAlias DESC \
            LIMIT 1";
    return executeQuery(sql);
}

function getDefaultProductReviews(upid) {
    let filter = createDefaultFilter();

    sql = "SELECT s.upid,up.productAlias,upc.upcid,upc.channelName, \
                pr.reviewID, pr.reviewTitle, pr.reviewBody, pr.reviewUser, \
                pr.reviewUserID, pr.verifiedPurchase, pr.reviewDate, \
                pr.reviewRating, pr.reviewSentiment, pr.reviewRelevance, \
                pr.positiveVotes, pr.negativeVotes, pr.totalVotes \
            FROM ProductReview pr \
            JOIN ProductChannel pc ON pr.pcid = pc.pcid AND pc.status = 'ACTIVE' \
            JOIN ProductChannelMapping pcm ON pc.pcid = pcm.pcid \
            JOIN UserProductChannel upc ON pcm.upcid = upc.upcid AND upc.status = 'ACTIVE' AND upc.upid = upid \
            JOIN UserProduct up ON upc.upid = '" + upid + "'\
            WHERE " + filter + " ";
            
    return executeQuery(sql).then(function(result) {
        productReviewData = result;
        console.log("productReviewData: ", productReviewData);
    });
}

function createDefaultFilter() {
    let cond = "";
    let prev7days = new Date() - 7;
    filterData = new Array();
    
    cond = cond.concat(" reviewDate >= '" + prev7days + "' ");
    cond = cond.concat(" SORT BY reviewDate DESC ");
    cond = cond.concat(" LIMIT 20 ");

    filterData.push({ "time" : prev7days });
    filterData.push({ "sortby" : "recent reviews"});
    filterData.push({ "limit" : "20" });

    console.log("createDefaultFilter: ", cond);

    return cond;
}

function getProductReviewsWithParams(idUserPool, params) {
    let filter = createParamFilters(params);

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
            JOIN Subscription s ON up.upid = s.upid AND s.idUserPool = '" + idUserPool + "' \
            WHERE up.upid = '" + params.upid + "' \
            AND s.subscriptionStatus = ACTIVE AND upc.upcid = '" + params.upcid + "' " + filter + " ";
            
    return executeQuery(sql).then(function(result) {
        productReviewData = result;
        console.log("productReviewData: ", productReviewData);
    });
}

function createParamFilters(params) { //tom add alias
    var cond = "";
    filterData = params;
    console.log("createParamFilters params: ", params);

    if (params.time != null) {
        if (params.time == 'select range') { //tom remove select trange
            if (params.timeFrom != null) {
                cond = cond.concat(" AND reviewDate >= '" + params.timeFrom + "'");
            }
        
            if (params.timeTo != null) {
                cond = cond.concat(" AND reviewDate <= '" + params.timeTo + "'");
            }

        } else {
            let time = new Date() - params.time; //TO TEST
            cond = cond.concat(" AND reviewDate >= '" + time + "'");
        }
    }

    if (params.rating != undefined) {
        cond = cond.concat(" AND reviewRating = '" + params.rating + "'");
    }

    if (params.sentiment != null) {
        cond =  cond.concat(" AND reviewSentiment = '" + params.sentiment + "'");
    }

    if (params.searchTerm != null) {
        let keyword = params.searchTerm.toLowerCase();
        cond = cond.concat(" AND LOWER(reviewBody) LIKE '%" + keyword + "%' ");
    }


    //SORTING
    if (params.sortby == 'highest rated') {
        cond = cond.concat(" ORDER BY reviewRating DESC");
    } else if (params.sortby == 'lowest rated') {
        cond = cond.concat(" ORDER BY reviewRating ASC");
    } else if (params.sortby == 'oldest reviews') {
        cond = cond.concat(" ORDER BY reviewDate ASC");
    }  else { //default is recent reviews
        cond = cond.concat(" ORDER BY reviewDate DESC");
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
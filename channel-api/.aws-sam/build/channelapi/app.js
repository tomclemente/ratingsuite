var mysql = require('mysql');

var connection = mysql.createConnection({
    host: process.env.RDS_ENDPOINT,
    user: process.env.RDS_USERNAME,
    password: process.env.RDS_PASSWORD,
    database: process.env.RDS_DATABASE
});

var sql;
var userid;

exports.handler = async (event) => {

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

            switch (event.httpMethod) {
                case 'GET':
                    sql = "SELECT channelName FROM ChannelMaster where status = 'ACTIVE'";
                    executeQuery(sql).then(resolve, reject);
                break;
                    
                default:
                    throw new Error(`Unsupported method "${event.httpMethod}"`);
            }    
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
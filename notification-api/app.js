var mysql = require('mysql');

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

exports.handler = async (event) => {
    
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

            switch (event.httpMethod) {

                case 'GET':

                    sql = "SELECT n.notificationTypeID, \
                                nt.desc, n.upid, n.flag \
                            FROM Notification n \
                            INNER JOIN NotificationType nt \
                                ON (n.notificationTypeID = nt.notificationTypeID) \
                            WHERE userid =  '" + userid +  "' ";

                    executeQuery(sql).then(resolve, reject);

                break;
                
                case 'POST':

                    if (!isEmpty(params.notificationTypeID)) {

                        sql = "SELECT n.notificationTypeID, \
                            nt.desc, n.upid, n.flag \
                            FROM Notification n \
                            INNER JOIN NotificationType nt \
                                ON (n.notificationTypeID = nt.notificationTypeID) \
                            WHERE userid =  '" + userid +  "' \
                            AND n.notificationTypeID  =  '" + params.notificationTypeID + "' ";

                        executeQuery(sql).then(resolve, reject);

                    } else {

                        if (isEmpty(params.upid)) {
                            reject({ statusCode: 500, body: "upid is missing" });
                        }
    
                        sql = "INSERT INTO Notification \
                                (userid, notificationTypeID, upid, flag) \
                                VALUES ('" + userid + "', 2, '" + params.upid + "', 1)";
    
                        executeQuery(sql).then(resolve, reject); 
                    }

                break;

                case 'PUT':

                    if (isEmpty(params.flag) || (params.flag != 0 && params.flag != 1)) {
                        reject({ statusCode: 500, body: "Invalid parameter." });
                    }
                    
                    sql = "UPDATE Notification \
                            SET flag = '" + params.flag + "' \
                            WHERE notificationTypeID = 1 AND userid =  '" + userid + "' ";
                    
                    executeQuery(sql).then(resolve, reject);

                break;

                case 'DELETE':

                    if (isEmpty(params.upid)) {
                        reject({ statusCode: 500, body: "upid is missing" });
                    }
                    
                    sql = "DELETE FROM Notification \
                            WHERE upid =  '" + params.upid + "' AND userid = '" + userid + "' ";
                    
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
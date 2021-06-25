var mysql = require('mysql');

var connection = mysql.createConnection({
    host: process.env.RDS_ENDPOINT,
    user: process.env.RDS_USERNAME,
    password: process.env.RDS_PASSWORD,
    database: process.env.RDS_DATABASE
});

exports.lambdaHandler = async (event, context) => {

    let username = event.requestContext.authorizer.claims.username;
    
    if (username == null) {
        throw new Error("Username missing. Not authenticated.");
    }
    
    console.log('User ID is: ', username);

    let body;
    let statusCode = '200';

    const headers = {
        'Content-Type': 'application/json',
    };

    try {

        connection.query('SELECT 1', function(error, results, fields) {
            if (error) {
                connection.connect(function(err) {
                    if (err) {
                        throw new Error("Unable to connect DB");
                    }
                })
            }
        });

        body = await new Promise((resolve, reject) => {

            let sql;
            switch (event.httpMethod) {

                case 'GET':
                    sql = "SELECT * FROM productchannel where userid = '" + username + "'";
                    break;

                case 'POST':
                    let params = JSON.parse(event["body"]);
                    let product = params.product;
                    let channel = params.channel;

                    sql = "INSERT INTO productchannel (userid, product, channel) \
                     VALUES ('" + username + "', '" + product + "', '" + channel + "')";
                    break;
                    
                default:
                    throw new Error(`Unsupported method "${event.httpMethod}"`);

            }

            connection.query(sql, function(err, result) {
                if (err) {
                    console.log("Error->" + err);
                    reject(err);
                }
                connection.end();
                resolve(result);

            });
        });

    } catch (err) {
        statusCode = '400';
        body = err.message;
    } finally {
        body = JSON.stringify(body);
        connection.end();
    }

    return {
        statusCode,
        body,
        headers,
    };
};

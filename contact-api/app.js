var AWS = require('aws-sdk');

exports.handler = async (event, context) => {
       
    let body;
    let statusCode = '200';
    let params = JSON.parse(event["body"]); 

    const headers = {
        'Content-Type': 'application/json',
    };

    try {    
        body = await new Promise((resolve, reject) => {
            var emailParam = generateEmailparam(params);
            sendEmail(emailParam).then(resolve,reject);
 
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

function generateEmailparam(params) {
    var param = {
        Destination: {
            ToAddresses: [process.env.TO_EMAIL]
        },
        Message: {
            Body: {
                Text: { Data: params.body}
            },
            Subject: { Data: params.name + " : " + params.subject + " : " + params.email }
        },
        Source: process.env.FROM_EMAIL
    };
    return param;
}

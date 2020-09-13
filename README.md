# RatingSuite

## Git Versioning

Clone the project from scratch.
```
git clone https://github.com/tomclemente/ratingsuite
```

Get the latest data from the repo.
```
git pull
```

**commit** and **push** the changes
```
git add app.js
git commit -m 'Commit Message'
git push
````

## Build and Deploy RatingSuite project

Install project dependencies. [npm](https://www.npmjs.com/get-npm) must be installed.

```
npm install
```

Build the serverless application. [aws-sam](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html) must be installed and configured using `aws-configure`
```
sam build
```

Deploy changes to AWS. 
```
sam deploy --guided
```


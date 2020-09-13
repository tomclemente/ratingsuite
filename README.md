# RatingSuite

## Git Versioning

Get latest data from repo
```
git pull
```

Commit and Push changes
```
git add app.js
git commit -m 'Commit Message'
git push
````

## Compile RatingSuite project

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


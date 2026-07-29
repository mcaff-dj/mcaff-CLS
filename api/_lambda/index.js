// Lambda entry point (handler: api/_lambda/index.handler). Wraps the Express app from
// app.js so API Gateway's event/response shape looks like a normal request/response to
// every existing api/*.js file - none of them needed to know they're running in Lambda.
const serverlessHttp = require('serverless-http');
const app = require('./app');

exports.handler = serverlessHttp(app);

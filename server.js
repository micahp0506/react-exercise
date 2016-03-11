'use strict';


const express = require('express');
const path = require('path');
const logger = require('morgan');
const bodyParser = require('body-parser');
// Babel ES6/JSX Compiler
require('babel-register');

const swig  = require('swig');
const React = require('react');
const ReactDOM = require('react-dom/server');
const Router = require('react-router');
const routes = require('./app/routes');
const mongoose = require('mongoose');
const Character = require('./models/character');
const config = require('./config');
let onlineUsers = 0;

const app =express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);

const PORT = process.env.PORT || 3000;
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

mongoose.connect(config.database);
mongoose.connection.on('error',() => {
  console.info('Error: Could not connect to MongoDB. Did you forget to run `mongod`?');
});

app.use((req, res) => {
  Router.match({ routes: routes.default, location: req.url }, (err, redirectLocation, renderProps) => {
    if (err) {
      res.status(500).send(err.message)
    } else if (redirectLocation) {
      res.status(302).redirect(redirectLocation.pathname + redirectLocation.search)
    } else if (renderProps) {
      let html = ReactDOM.renderToString(React.createElement(Router.RoutingContext, renderProps));
      let page = swig.renderFile('views/index.html', { html: html });
      res.status(200).send(page);
    } else {
      res.status(404).send('Page Not Found')
    }
  });
});

io.sockets.on('connection',(socket) => {
  onlineUsers++;

  io.sockets.emit('onlineUsers', { onlineUsers: onlineUsers });

  socket.on('disconnect',() => {
    onlineUsers--;
    io.sockets.emit('onlineUsers', { onlineUsers: onlineUsers });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

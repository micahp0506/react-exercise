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
const async = require('async');
const request = require('request');
const xml2js = require('xml2js');
const _ = require('underscore');
let onlineUsers = 0;

const app =express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);

const PORT = process.env.PORT || 3000;
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * POST /api/characters
 * Adds new character to the database.
 */
app.post('/api/characters',(req, res, next) => {
  let gender = req.body.gender;
  let characterName = req.body.name;
  let characterIdLookupUrl = 'https://api.eveonline.com/eve/CharacterID.xml.aspx?names=' + characterName;

  let parser = new xml2js.Parser();

  async.waterfall([
    (callback) => {
      request.get(characterIdLookupUrl, (err, request, xml) => {
        if (err) return next(err);
        parser.parseString(xml, (err, parsedXml) => {
          if (err) return next(err);
          try {
            let characterId = parsedXml.eveapi.result[0].rowset[0].row[0].$.characterID;

            Character.findOne({ characterId: characterId }, (err, character) => {
              if (err) return next(err);

              if (character) {
                return res.status(409).send({ message: character.name + ' is already in the database.' });
              }

              callback(err, characterId);
            });
          } catch (e) {
            return res.status(400).send({ message: 'XML Parse Error' });
          }
        });
      });
    },
    (characterId) => {
      let characterInfoUrl = 'https://api.eveonline.com/eve/CharacterInfo.xml.aspx?characterID=' + characterId;

      request.get({ url: characterInfoUrl }, (err, request, xml) => {
        if (err) return next(err);
        parser.parseString(xml, (err, parsedXml) => {
          if (err) return res.send(err);
          try {
            let name = parsedXml.eveapi.result[0].characterName[0];
            let race = parsedXml.eveapi.result[0].race[0];
            let bloodline = parsedXml.eveapi.result[0].bloodline[0];

            let character = new Character({
              characterId: characterId,
              name: name,
              race: race,
              bloodline: bloodline,
              gender: gender,
              random: [Math.random(), 0]
            });

            character.save((err) => {
              if (err) return next(err);
              res.send({ message: characterName + ' has been added successfully!' });
            });
          } catch (e) {
            res.status(404).send({ message: characterName + ' is not a registered citizen of New Eden.' });
          }
        });
      });
    }
  ]);
});

/**
 * GET /api/characters
 * Returns 2 random characters of the same gender that have not been voted yet.
 */
app.get('/api/characters', (req, res, next) => {
  let choices = ['Female', 'Male'];
  let randomGender = _.sample(choices);

  Character.find({ random: { $near: [Math.random(), 0] } })
    .where('voted', false)
    .where('gender', randomGender)
    .limit(2)
    .exec((err, characters) => {
      if (err) return next(err);

      if (characters.length === 2) {
        return res.send(characters);
      }

      let oppositeGender = _.first(_.without(choices, randomGender));

      Character
        .find({ random: { $near: [Math.random(), 0] } })
        .where('voted', false)
        .where('gender', oppositeGender)
        .limit(2)
        .exec((err, characters) => {
          if (err) return next(err);

          if (characters.length === 2) {
            return res.send(characters);
          }

          Character.update({}, { $set: { voted: false } }, { multi: true }, (err) => {
            if (err) return next(err);
            res.send([]);
          });
        });
    });
});

/**
 * PUT /api/characters
 * Update winning and losing count for both characters.
 */
app.put('/api/characters', (req, res, next) => {
  let winner = req.body.winner;
  let loser = req.body.loser;

  if (!winner || !loser) {
    return res.status(400).send({ message: 'Voting requires two characters.' });
  }

  if (winner === loser) {
    return res.status(400).send({ message: 'Cannot vote for and against the same character.' });
  }

  async.parallel([
      (callback) => {
        Character.findOne({ characterId: winner }, (err, winner) => {
          callback(err, winner);
        });
      },
      (callback) => {
        Character.findOne({ characterId: loser }, (err, loser) => {
          callback(err, loser);
        });
      }
    ],
    (err, results) => {
      if (err) return next(err);

      let winner = results[0];
      let loser = results[1];

      if (!winner || !loser) {
        return res.status(404).send({ message: 'One of the characters no longer exists.' });
      }

      if (winner.voted || loser.voted) {
        return res.status(200).end();
      }

      async.parallel([
        (callback) => {
          winner.wins++;
          winner.voted = true;
          winner.random = [Math.random(), 0];
          winner.save((err) => {
            callback(err);
          });
        },
        (callback) => {
          loser.losses++;
          loser.voted = true;
          loser.random = [Math.random(), 0];
          loser.save((err) => {
            callback(err);
          });
        }
      ], (err) => {
        if (err) return next(err);
        res.status(200).end();
      });
    });
});

/**
 * GET /api/characters/count
 * Returns the total number of characters.
 */
app.get('/api/characters/count', (req, res, next) => {
  Character.count({}, (err, count) => {
    if (err) return next(err);
    res.send({ count: count });
  });
});

/**
 * GET /api/characters/search
 * Looks up a character by name. (case-insensitive)
 */
app.get('/api/characters/search', (req, res, next) => {
  var characterName = new RegExp(req.query.name, 'i');

  Character.findOne({ name: characterName }, (err, character) => {
    if (err) return next(err);

    if (!character) {
      return res.status(404).send({ message: 'Character not found.' });
    }

    res.send(character);
  });
});

/**
 * GET /api/characters/top
 * Return 100 highest ranked characters. Filter by gender, race and bloodline.
 */
app.get('/api/characters/top', (req, res, next) => {
  let params = req.query;
  let conditions = {};

  _.each(params, (value, key) => {
    conditions[key] = new RegExp('^' + value + '$', 'i');
  });

  Character
    .find(conditions)
    .sort('-wins') // Sort in descending order (highest wins on top)
    .limit(100)
    .exec((err, characters) => {
      if (err) return next(err);

      // Sort by winning percentage
      characters.sort((a, b) => {
        if (a.wins / (a.wins + a.losses) < b.wins / (b.wins + b.losses)) { return 1; }
        if (a.wins / (a.wins + a.losses) > b.wins / (b.wins + b.losses)) { return -1; }
        return 0;
      });

      res.send(characters);
    });
});

/**
 * GET /api/characters/shame
 * Returns 100 lowest ranked characters.
 */
app.get('/api/characters/shame', (req, res, next) =>{
  Character
    .find()
    .sort('-losses')
    .limit(100)
    .exec((err, characters) => {
      if (err) return next(err);
      res.send(characters);
    });
});

/**
 * GET /api/characters/:id
 * Returns detailed character information.
 */
app.get('/api/characters/:id', (req, res, next) => {
  let id = req.params.id;

  Character.findOne({ characterId: id }, (err, character) => {
    if (err) return next(err);

    if (!character) {
      return res.status(404).send({ message: 'Character not found.' });
    }

    res.send(character);
  });
});

/**
 * POST /api/report
 * Reports a character. Character is removed after 4 reports.
 */
app.post('/api/report', (req, res, next) => {
  let characterId = req.body.characterId;

  Character.findOne({ characterId: characterId }, (err, character) => {
    if (err) return next(err);

    if (!character) {
      return res.status(404).send({ message: 'Character not found.' });
    }

    character.reports++;

    if (character.reports > 4) {
      character.remove();
      return res.send({ message: character.name + ' has been deleted.' });
    }

    character.save((err) => {
      if (err) return next(err);
      res.send({ message: character.name + ' has been reported.' });
    });
  });
});

/**
 * GET /api/stats
 * Returns characters statistics.
 */
app.get('/api/stats', (req, res, next) => {
  async.parallel([
      (callback) => {
        Character.count({}, (err, count) => {
          callback(err, count);
        });
      },
      (callback) => {
        Character.count({ race: 'Amarr' }, (err, amarrCount) => {
          callback(err, amarrCount);
        });
      },
      (callback) => {
        Character.count({ race: 'Caldari' }, (err, caldariCount) => {
          callback(err, caldariCount);
        });
      },
      (callback) => {
        Character.count({ race: 'Gallente' }, (err, gallenteCount) => {
          callback(err, gallenteCount);
        });
      },
      (callback) => {
        Character.count({ race: 'Minmatar' }, (err, minmatarCount) => {
          callback(err, minmatarCount);
        });
      },
      (callback) => {
        Character.count({ gender: 'Male' }, (err, maleCount) => {
          callback(err, maleCount);
        });
      },
      (callback) => {
        Character.count({ gender: 'Female' }, (err, femaleCount) => {
          callback(err, femaleCount);
        });
      },
      (callback) => {
        Character.aggregate({ $group: { _id: null, total: { $sum: '$wins' } } }, (err, totalVotes) => {
            let total = totalVotes.length ? totalVotes[0].total : 0;
            callback(err, total);
          }
        );
      },
      (callback) => {
        Character
          .find()
          .sort('-wins')
          .limit(100)
          .select('race')
          .exec((err, characters) => {
            if (err) return next(err);

            let raceCount = _.countBy(characters, (character) => { return character.race; });
            let max = _.max(raceCount, (race) => { return race });
            let inverted = _.invert(raceCount);
            let topRace = inverted[max];
            let topCount = raceCount[topRace];

            callback(err, { race: topRace, count: topCount });
          });
      },
      (callback) => {
        Character
          .find()
          .sort('-wins')
          .limit(100)
          .select('bloodline')
          .exec((err, characters) => {
            if (err) return next(err);

            let bloodlineCount = _.countBy(characters, (character) => { return character.bloodline; });
            let max = _.max(bloodlineCount, (bloodline) => { return bloodline });
            let inverted = _.invert(bloodlineCount);
            let topBloodline = inverted[max];
            let topCount = bloodlineCount[topBloodline];

            callback(err, { bloodline: topBloodline, count: topCount });
          });
      }
    ],
    (err, results) => {
      if (err) return next(err);

      res.send({
        totalCount: results[0],
        amarrCount: results[1],
        caldariCount: results[2],
        gallenteCount: results[3],
        minmatarCount: results[4],
        maleCount: results[5],
        femaleCount: results[6],
        totalVotes: results[7],
        leadingRace: results[8],
        leadingBloodline: results[9]
      });
    });
});

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

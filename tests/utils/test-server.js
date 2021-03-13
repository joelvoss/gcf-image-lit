import { json, text, urlencoded, raw } from 'body-parser';
import express from 'express';
import http from 'http';

export function getServer(userFunction) {
  // App to use for function executions.
  const app = express();

  function rawBodySaver(req, res, buf) {
    req.rawBody = buf;
  }

  // Set limit to a value larger than 32MB, which is maximum limit of higher
  // level layers anyway.
  const requestLimit = '1024mb';
  const defaultBodySavingOptions = {
    limit: requestLimit,
    verify: rawBodySaver,
  };
  const cloudEventsBodySavingOptions = {
    type: 'application/cloudevents+json',
    limit: requestLimit,
    verify: rawBodySaver,
  };
  const rawBodySavingOptions = {
    limit: requestLimit,
    verify: rawBodySaver,
    type: '*/*',
  };
  // Use extended query string parsing for URL-encoded bodies.
  const urlEncodedOptions = {
    limit: requestLimit,
    verify: rawBodySaver,
    extended: true,
  };

  // Apply middleware
  app.use(json(cloudEventsBodySavingOptions));
  app.use(json(defaultBodySavingOptions));
  app.use(text(defaultBodySavingOptions));
  app.use(urlencoded(urlEncodedOptions));
  // The parser will process ALL content types so MUST come last.
  // Subsequent parsers will be skipped when one is matched.
  app.use(raw(rawBodySavingOptions));
  app.enable('trust proxy');
  app.disable('x-powered-by');

  app.use('/favicon.ico|/robots.txt', (req, res) => {
    res.status(404).send(null);
  });

  app.all('/*', (req, res, next) => {
    userFunction(req, res, next);
  });

  return http.createServer(app);
}
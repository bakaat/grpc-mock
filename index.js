const { createServer } = require('grpc-kit');
const { Metadata } = require('grpc');
const partial_compare = require('partial-compare');
const UNEXPECTED_INPUT_PATTERN_ERROR = {
  code: 3,
  message: "unexpected input pattern"
};

function createMockServer({ rules, ...config }) {
  const grpcServer = createServer();
  grpcServer.routes = new RoutesFactory();

  grpcServer.getInteractionsOn = (method) => grpcServer.routes[method].interactions;
  grpcServer.clearInteractions = () => Object.keys(grpcServer.routes).forEach(method => grpcServer.routes[method].interactions.length = 0);

  grpcServer.addRule = ({ method, streamType, stream, input, output, error }) => {
    const handlerFactory = grpcServer.routes.getOrInitHandlerFactory(method)
    handlerFactory.addRule({ method, streamType, stream, input, output, error });
  }

  grpcServer.addRules = (rules) => {
    rules.forEach(grpcServer.addRule)
    return grpcServer.use({ ...config, routes: grpcServer.routes.generateRoutes() });
  }

  grpcServer.clearRules = (method) => {
    const handler = grpcServer.routes.getOrInitHandlerFactory(method);
    handler.rules.length = 0;
    handler.interactions.length = 0;
  }
  grpcServer.clearAllRules = () => {
    Object.keys(grpcServer.routes).forEach(grpcServer.clearRules);
  }

  rules.forEach(grpcServer.addRule)

  return grpcServer.use({ ...config, routes: grpcServer.routes.generateRoutes() });
}

class RoutesFactory {
  constructor() {
    this.routebook = {};
  }

  getOrInitHandlerFactory(method) {
    return this.getHandlerFactory(method) || this.initHandlerFactory(method);
  }

  getHandlerFactory(method) {
    return this.routebook[method];
  }

  initHandlerFactory(method) {
    this.routebook[method] = new HandlerFactory();
    return this.routebook[method];
  }

  generateRoutes() {
    return Object.entries(this.routebook).reduce((_routes, [method, handlerFactory]) => {
      if (handlerFactory.locked) return _routes;
      handlerFactory.locked = true;
      _routes[method] = handlerFactory.generateHandler();
      return _routes;
    }, {});
  }
}

const prepareMetadata = error => {
  let errorFields = Object.entries(error);
  if (error.metadata) {
    const grpcMetadata = Object.entries(error.metadata)
      .reduce((m, [k, v]) => (m.add(k, String(v)), m), new Metadata());
    errorFields = [
      ...errorFields,
      ['metadata', grpcMetadata],
    ];
  }
  return errorFields.reduce((e, [k, v]) => (e[k] = v, e), new Error());
};

class HandlerFactory {
  constructor() {
    this.rules = [];
    this.locked = false;
  }

  addRule(rule) {
    this.rules.push(rule);
  }

  generateHandler() {
    let interactions = [];
    const handler = function (call, callback) {

      /*
       * On each request handlers are generated for that request based on the
       * defined rules. It is possible, if there are multiple rules for a 
       * method, that mutiple handlers will get generated and each will
       * attempt to process the incoming messages. This can lead to multiple
       * handlers attempting to respond and all sort of nastiness happens.
       *
       * To "work-a-round" this some state variables are used to capture the
       * responses from each of the handlers for a rule and insure only a
       * single response is sent.
       *
       * The basic flows is capture the output of each handler and when they
       * all have run to completion look at the results and pick the best one,
       * where best is defined (in order) as:
       * 1. a successful match and response
       * 2. a successful match and error
       * 3. an unexpected pattern error
       *
       * Before kicking off the processing the number of know rules is known
       * to be `this.rules.length`, so it is known haw many response should
       * be expected.
       */
      var response = {
          // number of yet to complete rule handlers
          active: this.rules.length,

          // used to capture a successful output
          output: undefined,

          // used to capture an error output
          error: undefined,

          // used to capture interaction data (needed for testing)
          data: [],

          // used by the `mutual` client handling to ensure only a single
          // rule is matched
          locked: false,
      };
      for (const { streamType, stream, input, output, error } of this.rules) {
        if (streamType === 'client') {
          // give each rule handler its own "done" and data stack variables
          (function () {
            var done = false
            var dataStack = []
            call.on('data', async function (memo, data) {
              if (!done) {
                memo.push(data);
                dataStack.push(data)
                const included = memo.reduce((_matched, memoData, index) => {
                  if(stream[index]){
                    return _matched && isMatched(memoData, stream[index].input);
                  }else{
                    return false;
                  }
                }, true);
                const matched = included && memo.length === stream.length;
  
                if (matched) {
                  if (error) {
                    response.error = error;
                    response.active = response.active - 1;
                    response.data = dataStack;
                    done = true
                  } else {
                    if (typeof output === 'function') {
                      response.output = await output({ request: call.request });
                    } else {
                      response.output = output;
                    }
                    response.active = response.active - 1;
                    response.data = dataStack;
                    done = true
                  }
                } else if(included) {
                  //nothing todo
                } else {
                  response.active = response.active - 1;
                  response.data = dataStack;
                  done = true;
                }
              }
              if (response.active == 0) {
                // set to -1 so no one else attempts to set the output
                response.active = -1
                for (var i in response.data) {
                  interactions.push(dataStack[i])
                }
                if (response.output) {
                  callback(null, response.output);
                } else if (response.error) {
                  callback(prepareMetadata(response.error));
                } else {
                  callback(prepareMetadata(UNEXPECTED_INPUT_PATTERN_ERROR));
                }
              }
            }.bind(null, []));
          })();
        } else if (streamType === 'server') {
          var dataStack = [];
          dataStack.push(call.request);
          if (isMatched(call.request, input)) {
            if (error) {
              response.data = dataStack;
              response.error = error;
            } else {
              response.data = dataStack;
              if (typeof stream === 'function') {
                response.output = stream({ request: call.request });
              } else {
                response.output = stream;
              }
            }
          } else {
            response.data = dataStack;
          }
          response.active = response.active - 1;
          if (response.active == 0) {
            // set to -1 so no one else attempts to set the output
            response.active = -1;
            for (var i in response.data) {
              interactions.push(dataStack[i])
            }
            if (response.output) {
              for (const { output } of response.output) {
                call.write(output);
              }
            } else if (response.error) {
              call.emit('error', prepareMetadata(response.error));
            } else {
              call.emit('error', prepareMetadata(UNEXPECTED_INPUT_PATTERN_ERROR));
            }
            call.end();
          }
        } else if (streamType === 'mutual') {
          /*
           * `mutual` handling is a little bit different because we can't
           * attempt a "best" match and then give output. Instead we we "lock"
           * on to the first rule that matches and run that to completion.
           * Once one rule is locked, the other will simply be no-ops.
           */
          (function () {
            var done = false;
            var haveLock = false;
            call.on('data', function (stream, memo, data) {
              if (response.locked && !haveLock) {
                if (!done) {
                  response.active = response.active = 1;
                  done = true;
                }
              }
              if (!done) {
                memo.push(data);

                if (haveLock && error) {
                  interactions.push(data);
                  response.active = response.active - 1;
                  response.error = error;
                  done = true;
                  call.emit('error', prepareMetadata(error));
                } else if (haveLock && stream && stream[0] && !stream[0].input) {
                  interactions.push(data);
                  let { output } = stream.shift();
                  if (typeof output === 'function') {
                    output = output({ request: memo[0]});
                  }
                  call.write(output);
                } else if ((haveLock || !response.locked) && stream && stream[0] && isMatched(memo[0], stream[0].input)) {
                  interactions.push(data);
                  response.locked = true;
                  if (!haveLock) {
                    response.active = response.active - 1;
                    haveLock = true;
                  }
                  let { output } = stream.shift();
                  if (typeof output === 'function') {
                    output = output({ request: memo[0]});
                  }
                  memo.shift();
                  if (output) {
                    call.write(output);
                  }
                } else if (haveLock) {
                  //TODO: raise error
                  interactions.push(data);
                  call.emit('error', prepareMetadata(UNEXPECTED_INPUT_PATTERN_ERROR));
                  call.end();
                } else {
                  response.active = response.active - 1;
                  done = true;
                }

                if (haveLock && stream.length === 0) {
                  call.end();
                }
              }
              if (!response.locked && response.active == 0) {
                call.emit('error', prepareMetadata(UNEXPECTED_INPUT_PATTERN_ERROR));
                call.end();
              }
            }.bind(null, [...stream], []));
          })()
        } else {
          if (isMatched(call.request, input)) {
            if (error) {
              response.error = error;
            } else {
              if (typeof output === 'function') {
                response.output = output({ request: call.request });
              } else {
                response.output = output;
              }
            }
          }
          response.active = response.active - 1;
          if (response.active == 0) {
            // set to -1 so no one else attempts to set the output
            response.active = -1;
            interactions.push(call.request);
            if (response.output) {
              callback(null, response.output);
            } else if (response.error) {
              callback(prepareMetadata(response.error));
            } else {
              callback(prepareMetadata(UNEXPECTED_INPUT_PATTERN_ERROR));
            }
          }
        }
      }
    }.bind(this);
    handler.interactions = interactions;
    return handler;
  }

}

function isMatched(actual, expected) {
  if (typeof expected.test === 'function') {
    return expected.test(actual);
  }
  if (expected instanceof RegExp) {
    return JSON.stringify(actual).match(expected);
  } else {
    if (process.env.GRPC_MOCK_COMPARE && process.env.GRPC_MOCK_COMPARE == "sparse") {
      return partial_compare(actual, expected);
    }
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
}

exports.createMockServer = createMockServer;

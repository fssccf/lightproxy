var https = require('https');
var http = require('http');
var net = require('net');
var url = require('url');
var mime = require('mime');
var extend = require('extend');
var util = require('../util');
var Transform = require('pipestream').Transform;
var h2 = require('../https/h2');
var ws = require('ws');

var WhistleTransform = util.WhistleTransform;
var SpeedTransform = util.SpeedTransform;
var ReplacePatternTransform = util.ReplacePatternTransform;
var ReplaceStringTransform = util.ReplaceStringTransform;
var FileWriterTransform = util.FileWriterTransform;
var rules = require('../rules');
var pluginMgr = require('../plugins');
var hparser = require('hparser');
var config = require('../config');
var formatHeaders = hparser.formatHeaders;
var getRawHeaderNames = hparser.getRawHeaderNames;

var LOCALHOST = '127.0.0.1';
var DOCTYPE = util.toBuffer('<!DOCTYPE html>\r\n');
var CRLF = util.toBuffer('\r\n');
var MAX_RES_SIZE = 512 * 1024;
var JSON_RE = /{[\w\W]*}|\[[\w\W]*\]/;
var LIKE_JSON_RE = /^\s*[\{\[]/;
var X_RE = /^x/;
var BODY_PROTOCOLS = ['attachment', 'resReplace', 'resBody', 'resPrepend', 'resAppend',
  'htmlBody', 'htmlPrepend', 'htmlAppend', 'jsBody', 'jsPrepend', 'jsAppend',
  'cssBody', 'cssPrepend', 'cssAppend', 'resWrite', 'resWriteRaw', 'resMerge'];
var BODY_PROTOCOLS_LEN = BODY_PROTOCOLS.length;

const boardcastPort = process.env.LIGHTPROXY_BOARDCASR_PORT;

console.log('Whistle get boardcast port', boardcastPort);

const wsClient = new ws(`ws://127.0.0.1:${boardcastPort}`);
const clientReady = new Promise(resolve => {
  wsClient.onopen = () => {
        resolve();
    };
});

wsClient.onerror = err => {
    console.error(err);
};


function notAllowCache(resRules) {
  for (var i = 0; i < BODY_PROTOCOLS_LEN; i++) {
    if (resRules[BODY_PROTOCOLS[i]]) {
      return true;
    }
  }
}

function pipeClient(req, client) {
  if (req.hasError) {
    client.abort();
  } else if (req.noReqBody) {
    req._clientReq = client;
    client.end();
  } else {
    req.pipe(client);
  }
}

function showDnsError(res, err) {
  res.response(util.wrapGatewayError('DNS Lookup Failed\r\n' + util.getErrorStack(err)));
}

function setCookies(headers, data) {
  var newCookies = data.headers['set-cookie'];
  if (!Array.isArray(newCookies)) {
    if (!newCookies || typeof newCookies !== 'string') {
      return;
    }
    newCookies = newCookies.split(',');
  }
  if (newCookies.length) {
    var cookies = headers['set-cookie'];
    var isArray = Array.isArray(cookies);
    if (!isArray && cookies) {
      isArray = true;
      cookies = [String(cookies)];
    }
    if (isArray) {
      var newNameMap = {};
      newCookies.forEach(function(cookie) {
        var index = cookie.indexOf('=');
        var name = index == -1 ? name : cookie.substring(0, index);
        newNameMap[name] = 1;
      });
      cookies.forEach(function(cookie) {
        var index = cookie.indexOf('=');
        var name = index == -1 ? name : cookie.substring(0, index);
        if (!newNameMap[name]) {
          newCookies.push(cookie);
        }
      });
    }
    headers['set-cookie'] = newCookies;
    delete data.headers['set-cookie'];
  }
}

function handleReplace(res, replacement) {
  if (!replacement) {
    return;
  }

  var type = util.getContentType(res.headers);
  if (!type || type == 'IMG') {
    return;
  }

  Object.keys(replacement).forEach(function(pattern) {
    var value = replacement[pattern];
    if (util.isOriginalRegExp(pattern) && (pattern = util.toOriginalRegExp(pattern))) {
      res.addTextTransform(new ReplacePatternTransform(pattern, value));
    } else if (pattern) {
      res.addTextTransform(new ReplaceStringTransform(pattern, value));
    }
  });
}

function getWriterFile(file, statusCode) {
  if (!file || statusCode == 200) {
    return file;
  }

  return file + '.' + statusCode;
}

function readFirstChunk(req, res, src, cb) {
  var ports = req._pipePluginPorts;
  if (!cb) {
    if (ports.reqReadPort || ports.reqWritePort) {
      delete req.headers['content-length'];
    }
    return ports.reqReadPort ? req.getPayload(res, 1) : res();
  }
  if (ports.resReadPort || ports.resWritePort) {
    delete src.headers['content-length'];
  }
  if (!ports.resReadPort) {
    return cb();
  }
  res.prepareSrc(src, function(stream) {
    var handler = function(chunk) {
      stream.pause();
      stream.removeListener('data', handler);
      stream.removeListener('end', handler);
      cb(chunk);
    };
    stream.on('data', handler);
    stream.on('end', handler);
  });
}

function setProxyAgent(options, proxyOpts) {
  proxyOpts.cacheKey = options.cacheKey;
  options.agent = proxyOpts.isSocks ? config.getSocksAgent(proxyOpts) : config.getHttpsAgent(proxyOpts);
}

module.exports = function(req, res, next) {
  var origProto;
  var resRules = req.rules;
  var deleteHeaders = util.parseDeleteProperties(req);

  req.request = function(options) {
    readFirstChunk(req, function() {
      options = options || req.options;
      req.realUrl = res.realUrl = options.isPlugin ? (req._realUrl || req.fullUrl) : options.href;
      var originPort = options.port;
      var now = Date.now();
      rules.getClientCert(req, function(key, cert, isPfx, cacheKey) {
        rules.getProxy(options.href, options.isPlugin ? null : req, function(err, hostIp, hostPort) {
          var proxyRule = resRules.proxy;
          var proxyUrl = !options.isPlugin && proxyRule ? util.rule.getMatcher(proxyRule) : null;
          var headers = req.headers;
          var curUrl, auth, isInternalProxy, isHttpsProxy, origPath, origProxy;
          if (!hostIp) {
            if (options.localDNS && net.isIP(options.host)) {
              curUrl = options.host;
            } else if (proxyUrl) {
              isHttpsProxy = proxyRule.isHttps || proxyRule.isHttpsInternal;
              isInternalProxy = proxyRule.isInternal;
              if (isInternalProxy || proxyRule.isHttps2http) {
                if (isInternalProxy && options.protocol === 'https:') {
                  headers[config.HTTPS_FIELD] = 1;
                  origProto = options.protocol;
                  options.protocol = null;
                }
              } else if (proxyRule.isHttp2https) {
                options.protocol = 'https:';
              }
              curUrl = 'http:' + util.removeProtocol(proxyUrl);
            } else {
              curUrl = options.href;
            }
          }
          req.curUrl = curUrl;
          req.setServerPort = req.setServerPort || util.noop;
          rules.resolveHost(req, function(err, ip, port, host) {
            var setHostsInfo = function(_ip, _port, _host, withPort) {
              ip = _ip || '127.0.0.1';
              port = _port;
              req.dnsTime = Date.now() - now;
              req.hostIp = util.getHostIp(_ip, withPort && _port );
              if (_host) {
                resRules.host = _host;
              }
            };
            setHostsInfo(hostIp || ip, hostPort || port, host);
            if (err) {
              showDnsError(res, err);
              return;
            }
            if (req.disable.keepalive) {
              req.disable.keepAlive = true;
            }
            var isHttps = options.protocol == 'https:';
            var proxyOptions, isProxyPort, isSocks;
            var setAgent = function(disable) {
              if (disable || req.disable.keepAlive || (isHttps && cert)) {
                options.agent = false;
              } else {
                options.agent = isHttps ? config.httpsAgent : config.httpAgent;
              }
            };
            if (proxyUrl) {
              proxyOptions = url.parse(proxyUrl);
              proxyOptions.host = ip;
              isSocks = proxyRule.isSocks;
              var proxyPort = proxyOptions.port;
              if (!proxyPort) {
                proxyPort = proxyOptions.port = isSocks ? 1080 : (isHttpsProxy ? 443 : 80);
              }
              if (proxyOptions.auth) {
                auth = 'Basic ' + util.toBuffer(proxyOptions.auth + '').toString('base64');
              }
              if (isHttps || isSocks || isHttpsProxy || req._phost) {
                isProxyPort = util.isProxyPort(proxyPort);
                if (isProxyPort && util.isLocalAddress(ip)) {
                  req.setServerPort(config.port);
                  res.response(util.wrapResponse({
                    statusCode: 302,
                    headers: {
                      location: 'http://' + util.getHostIp(ip, config.port) + (options.path || '')
                    }
                  }));
                } else {
                  var curServerPort = options.port || (isHttps ? 443 : 80);
                  var proxyHeaders = {
                    host: options.hostname + ':' + curServerPort,
                    'proxy-connection': 'keep-alive'
                  };
                  if (auth) {
                    proxyHeaders['proxy-authorization'] = auth;
                  }
                  var ua = !req.disable.proxyUA && headers['user-agent'];
                  if (ua) {
                    proxyHeaders['user-agent'] = ua;
                  }
                  if (!util.isLocalAddress(req.clientIp)) {
                    proxyHeaders[config.CLIENT_IP_HEAD] = req.clientIp;
                  }
                  if (isHttps) {
                    util.checkIfAddInterceptPolicy(proxyHeaders, headers);
                  }
                  if (isProxyPort) {
                    proxyHeaders[config.WEBUI_HEAD] = 1;
                  } else if (util.isProxyPort(curServerPort)) {
                    headers[config.WEBUI_HEAD] = 1;
                  }
                  util.setClientId(proxyHeaders, req.enable, req.disable, req.clientIp, isInternalProxy);
                  var opts = {
                    isSocks: isSocks,
                    isHttps: isHttps,
                    proxyServername: isHttpsProxy ? proxyOptions.hostname : null,
                    proxyHost: ip,
                    clientIp: proxyHeaders[config.CLIENT_IP_HEAD],
                    proxyPort: proxyPort,
                    url: options.href,
                    auth: proxyOptions.auth,
                    headers: proxyHeaders
                  };
                  var phost = req._phost;
                  if (phost) {
                    options.host = phost.hostname;
                    if (phost.port > 0) {
                      options.port = phost.port;
                    } else if (!options.port) {
                      options.port = isHttps ? 443 : 80;
                    }
                    proxyHeaders.host = options.host + ':' + options.port;
                  } else {
                    options.host = options.hostname;
                  }
                  options._proxyOptions = opts;
                  opts.proxyType = isSocks ? 'socks' : (isHttpsProxy ? 'https' : 'http');
                  options._proxyPort = opts.proxyPort;
                  origProxy = opts;
                  request(options);
                }
                return;
              }

              if (auth) {
                headers['proxy-authorization'] = auth;
              }
            }

            req.hostIp = util.getHostIp(ip, port);
            port = proxyOptions ? proxyOptions.port : (port || options.port);
            options.host = ip;//设置ip
            var curPort = port || (isHttps ? 443 : 80);
            isProxyPort = util.isProxyPort(curPort);
            var isLocalAddress = util.isLocalAddress(options.host);
            if (isProxyPort && isLocalAddress) {
              var redirectHost = config.customLocalUIHost || ip;
              var redirectPort = config.realPort || config.port;
              res.response(util.wrapResponse({
                statusCode: 302,
                headers: {
                  location: 'http://' + util.getHostIp(redirectHost, redirectPort) + (options.path || '')
                }
              }));
            } else {
              if (isProxyPort || util.isProxyPort(options.port || (isHttps ? 443 : 80))) {
                headers[config.WEBUI_HEAD] = 1;
              }
              setAgent(isLocalAddress);
              request(options, port, true);
            }
            function request(options, serverPort, direct) {
              options.headers = headers;
              options.method = req.method;
              options.rejectUnauthorized = config.rejectUnauthorized;
              if (!options.isPlugin && !req._customHost && (req.fullUrl !== req.realUrl || !headers.host)) {
                headers.host = options.hostname;
                if (options.port && options.port != (isHttps ? 443 : 80)) {
                  headers.host += ':' + options.port;
                }
              }
              if (req.disable.keepAlive) {
                headers.connection = 'close';
              }
              if (direct) {
                options.port = serverPort;
                if (proxyUrl) {
                  origPath = options.path || '';
                }
              }

              delete options.hostname; //防止自动dns
              delete options.protocol;
              if (isHttps) {
                options.servername = util.parseHost(headers.host)[0];
              }
              var piped;
              var maxRetryCount = 1;
              var retryCount = 0;
              var retryXHost = 0;
              var resetCount = 0;
              var curClient, timer;
              var retry = function(err) {
                clearTimeout(timer);
                timer = null;
                if (curClient) {
                  curClient.removeListener('error', retry);
                  curClient.removeListener('close', retry);
                  curClient.on('error', util.noop);
                  curClient = null;
                }
                if (req.hasError || req._hasRespond) {
                  return;
                }
                if (err && isHttps && !options.ciphers && util.isCiphersError(err)) {
                  options.ciphers = util.TLSV2_CIPHERS;
                  return send();
                }
                if (retryCount >= maxRetryCount) {
                  var toHttp;
                  if (isHttps && (!piped || req.noReqBody) && util.checkTlsError(err) && util.checkAuto2Http(req, ip, proxyUrl)) {
                    isHttps = false;
                    toHttp = true;
                    req.httpsTime = req.httpsTime || Date.now();
                    req.useHttp = true;
                    if (origProxy) {
                      origProxy.isHttps = false;
                      if (req._phost && !req._phost.port) {
                        options.port = 80;
                        origProxy.headers.host = req._phost.hostname + ':80';
                      }
                      setProxyAgent(options, origProxy);
                    } else {
                      setAgent(util.isLocalAddress(ip));
                    }
                  }
                  var code = err && err.code;
                  if (!toHttp && (resetCount > 1 || (code !== 'EPROTO' && code !== 'ECONNRESET') || (piped && !req.noReqBody))) {
                    var stack = util.getErrorStack(err || new Error('socket connect timeout'));
                    res.response(util.wrapGatewayError(stack));
                  } else {
                    ++resetCount;
                    send();
                  }
                  return;
                }
                ++retryCount;
                if (proxyUrl) {
                  if (X_RE.test(proxyUrl)) {
                    proxyUrl = '';
                    req._phost = undefined;
                    if (isInternalProxy) {
                      isHttps = origProto === 'https:';
                    }
                    req.curUrl = req.realUrl;
                    delete options._proxyPort;
                    rules.resolveHost(req, function(_err, _ip, _port, _host) {
                      setAgent(util.isLocalAddress(_ip));
                      setHostsInfo(_ip, _port, _host, true);
                      if (_err) {
                        showDnsError(res, _err);
                        return;
                      }
                      options.host = ip;
                      options.port = _port || originPort;
                      ++maxRetryCount;
                      send();
                    });
                    return;
                  }
                } else if (retryXHost < 2 && req.rules.host && X_RE.test(req.rules.host.matcher)) {
                  ++maxRetryCount;
                  ++retryXHost;
                  if (retryXHost > 1) {
                    req.curUrl = req.realUrl;
                    delete options._proxyPort;
                    rules.lookupHost(req, function(_err, _ip) {
                      setHostsInfo(_ip);
                      if (_err) {
                        showDnsError(res, _err);
                        return;
                      }
                      options.host = ip;
                      options.port = originPort;
                      send();
                    });
                    return;
                  }
                } else if (isHttps && util.checkAuto2Http(req, ip, proxyUrl)) {
                  ++maxRetryCount;
                  if (maxRetryCount > 2 || util.checkTlsError(err)) {
                    isHttps = false;
                    req.httpsTime = req.httpsTime || Date.now();
                    req.useHttp = true;
                    setAgent(util.isLocalAddress(options.host));
                  }
                }
                send();
              };
              var send = function(sock) {
                if (req.hasError) {
                  return;
                }
                req.useH2 = false;
                if (options._proxyOptions) {
                  setProxyAgent(options, options._proxyOptions);
                  delete options._proxyOptions;
                }
                req.setServerPort(options._proxyPort || options.port || (isHttps ? 443 : 80));
                if (origPath != null && proxyUrl) {
                  origPath = null;
                  options.path = (isHttps ? 'https:' : 'http:') + '//' + (headers.host || options.host) + (options.path || '/');
                }
                if (sock) {
                  options.agent = null;
                  options.createConnection = function() {
                    return sock;
                  };
                }
                options.protocol = isHttps ? 'https:' : 'http:';
                try {
                  var client = (isHttps ? https : http).request(options, res.response);
                  curClient = client;
                  client.once('error', retry);
                  client.once('close', retry);
                  client.once('socket', function(socket) {
                    if (socket.connecting || socket._connecting) {
                      timer = setTimeout(function() {
                        socket.destroy();
                        timer = null;
                        retry();
                      }, 16000);
                      socket.once((isHttpsProxy || isHttps) ? 'secureConnect' : 'connect', function() {
                        retryCount = maxRetryCount;
                        piped = true;
                        clearTimeout(timer);
                        timer = null;
                        pipeClient(req, client);
                      });
                    } else {
                      retryCount = maxRetryCount;
                      piped = true;
                      pipeClient(req, client);
                    }
                  });
                } catch(e) {
                  res.response(util.wrapGatewayError(util.getErrorStack(e)));
                }
              };
              if (req.disable.clientIp || req.disable.clientIP) {
                delete headers[config.CLIENT_IP_HEAD];
              } else {
                var forwardedFor = util.getMatcherValue(resRules.forwardedFor);
                if (net.isIP(forwardedFor)) {
                  headers[config.CLIENT_IP_HEAD] = forwardedFor;
                } else if (net.isIP(req._customXFF)) {
                  headers[config.CLIENT_IP_HEAD] = req._customXFF;
                } else if ((!config.keepXFF && !options.isPlugin && (isHttps || isSocks || !proxyUrl)) || util.isLocalAddress(req.clientIp)) {
                  delete headers[config.CLIENT_IP_HEAD];
                } else {
                  headers[config.CLIENT_IP_HEAD] = req.clientIp;
                }
              }

              Object.keys(deleteHeaders.reqHeaders).forEach(function(prop) {
                delete headers[prop];
              });
              var optHeaders = options.headers;
              var isDelete = options.method === 'DELETE' && optHeaders['content-length'] == null;
              if (isDelete) {
                delete optHeaders['transfer-encoding'];
              }
              if (proxyUrl) {
                util.setClientId(optHeaders, req.enable, req.disable, req.clientIp, isInternalProxy);
              } else {
                var clientId = optHeaders[config.CLIENT_ID_HEADER];
                if (clientId) {
                  util.removeClientId(optHeaders);
                  req.setClientId && req.setClientId(clientId);
                }
              }
              if (req.isH2 && (headers[config.HTTPS_FIELD] || options.isPlugin)) {
                headers[config.ALPN_PROTOCOL_HEADER] = 'h2';
              }
              options.headers = optHeaders = formatHeaders(optHeaders, req.rawHeaderNames);
              delete headers[config.WEBUI_HEAD];
              if (headers[config.HTTPS_FIELD]) {
                delete headers[config.HTTPS_FIELD];
                delete headers[config.ALPN_PROTOCOL_HEADER];
              }
              if (isDelete) {
                optHeaders['Transfer-Encoding'] = 'chunked';
              }
              if (options.isPlugin) {
                optHeaders[config.PLUGIN_HOOK_NAME_HEADER] = config.PLUGIN_HOOKS.HTTP;
              }
              req.noReqBody = !util.hasRequestBody(req);
              if (req.hasError) {
                return;
              }
              if (req.method === 'DELETE' && (req._hasInjectBody ||
                req.headers['transfer-encoding'] || req.headers['content-length'] > 0)) {
                req.useH2 = false;
              } else {
                req.useH2 = isHttps && config.enableH2 && ((req.isH2 && !util.isDisableH2(req)) || util.isEnableH2(req));
              }
              req.setServerPort(options._proxyPort || options.port || (isHttps ? 443 : 80));
              req.options = options;
              isHttps && util.setClientCert(options, key, cert, isPfx, cacheKey);
              h2.request(req, res, send);
            }
          }, req.pluginRules, req.rulesFileMgr, req.headerRulesMgr);
        });
      });
    });
  };

  res.response = function(_res) {
    if (req._hasRespond) {
      return;
    }
    req._hasRespond = true;
    if (_res.realUrl) {
      req.realUrl = res.realUrl = _res.realUrl;
    }
    res.headers = req.resHeaders = _res.headers;
    res._originEncoding = _res.headers['content-encoding'];
    req.statusCode = _res.statusCode;
    if (_res.rawHeaderNames) {
      res.rawHeaderNames = _res.rawHeaderNames;
    } else {
      res.rawHeaderNames = _res.rawHeaderNames = Array.isArray(_res.rawHeaders) ?
      getRawHeaderNames(_res.rawHeaders) : {};
    }
    _res.on('error', function(err) {
      res.emit('error', err);
    });
    util.drain(req, function() {
      readFirstChunk(req, res, _res, function(firstChunk){
        pluginMgr.getResRules(req, _res, function() {
          var replaceStatus = util.getMatcherValue(resRules.replaceStatus);
          if (replaceStatus && replaceStatus != _res.statusCode) {
            res.statusCode = _res.statusCode = replaceStatus;
            util.handleStatusCode(replaceStatus, _res.headers);
          }
          if (req.disable['301'] && _res.statusCode == 301) {
            res.statusCode = _res.statusCode = 302;
          }

          var ruleList = [resRules.resHeaders, resRules.resCookies, resRules.resCors, resRules.resReplace, resRules.resMerge, resRules.trailers];
          util.parseRuleJson(ruleList, function(headers, cookies, cors, replacement, params, newTrailers) {
            var data = {};
            if (headers) {
              data.headers = extend(data.headers || {}, headers);
            }
            if (data.body && typeof data.body !== 'string') {
              try {
                data.body = JSON.stringify(data.body);
              } catch(e) {}
            }
            if (data.headers) {
              data.headers = util.lowerCaseify(data.headers, res.rawHeaderNames);
            }

            util.setResCookies(data, cookies);
            util.setResCors(data, cors, req);

            var cache = util.getMatcherValue(resRules.cache);
            if (cache === 'reserve') {
              req._customCache = true;
            } else {
              var maxAge = parseInt(cache, 10);
              var noCache = /^(?:no|no-cache|no-store)$/i.test(cache) || maxAge < 0;
              if (maxAge > 0 || noCache) {
                req._customCache = true;
                util.setHeaders(data, {
                  'cache-control': noCache ? (/^no-store$/i.test(cache) ? 'no-store' : 'no-cache') : 'max-age=' + maxAge,
                  'expires': new Date(Date.now() + (noCache ? -60000000 : maxAge * 1000)).toGMTString(),
                  'pragma': noCache ? 'no-cache' : ''
                });
              }
            }

            if (resRules.attachment) {
              var attachment = util.getMatcherValue(resRules.attachment) || util.getFilename(req.fullUrl);
              util.setHeader(data, 'content-disposition', 'attachment; filename="' + util.encodeNonLatin1Char(attachment) + '"');
            }

            if (resRules.resType) {
              var newType = util.getMatcherValue(resRules.resType).split(';');
              var type = newType[0];
              newType[0] = (!type || type.indexOf('/') != -1) ? type : mime.lookup(type, type);
              util.setHeader(data, 'content-type', newType.join(';'));
            }

            if (resRules.resCharset) {
              data.charset = util.getMatcherValue(resRules.resCharset);
            }

            var resDelay = util.getMatcherValue(resRules.resDelay);
            resDelay = resDelay && parseInt(resDelay, 10);
            if (resDelay > 0) {
              data.delay = resDelay;
            }

            var resSpeed = util.getMatcherValue(resRules.resSpeed);
            resSpeed = resSpeed && parseFloat(resSpeed);
            if (resSpeed > 0) {
              data.speed = resSpeed;
            }

            util.readInjectFiles(data, function(data) {
              var headers = _res.headers;
              var type, cusHeaders;
              if (data.headers) {
                setCookies(headers, data);
                type = data.headers['content-type'];
                if (typeof type == 'string') {
                  if (type.indexOf(';') == -1) {
                    var origType = headers['content-type'];
                    if (typeof origType == 'string' && origType.indexOf(';') != -1) {
                      origType = origType.split(';');
                      origType[0] = type;
                      data.headers['content-type'] = origType.join(';');
                    }
                  }
                } else {
                  delete data.headers['content-type'];
                }
                cusHeaders = data.headers;
                extend(headers, cusHeaders);
              }

              if (data.charset && typeof data.charset == 'string') {
                type = headers['content-type'];
                type = typeof type == 'string' ? type.trim().split(';')[0] : '';
                type = type || mime.lookup(req.fullUrl.replace(/[?#].*$/, ''), 'text/html');
                headers['content-type'] = type + '; charset=' + data.charset;
              } else {
                delete data.charset;
              }
              if (!headers.pragma) {
                delete headers.pragma;
              }
              var hr = util.parseHeaderReplace(resRules.headerReplace);
              util.handleHeaderReplace(headers, hr.res);
              if (headers.location) {
                //nodejs的url只支持ascii，对非ascii的字符要encodeURIComponent，否则传到浏览器是乱码
                headers.location = util.encodeNonLatin1Char(headers.location);
              }
              type = util.getContentType(headers);
              var charset = util.getCharset(headers['content-type']);
              var isHtml = type === 'HTML';
              var isJs = isHtml || type === 'JS';
              var isCss = isHtml || type === 'CSS';
              var hasResBody = util.hasBody(_res, req);
              util.getRuleValue([resRules.resBody, resRules.resPrepend, resRules.resAppend,
                isHtml && resRules.htmlAppend, isJs && resRules.jsAppend, isCss && resRules.cssAppend,
                isHtml && resRules.htmlBody, isJs && resRules.jsBody, isCss && resRules.cssBody,
                isHtml && resRules.htmlPrepend, isJs && resRules.jsPrepend, isCss && resRules.cssPrepend],
              function(resBody, resPrepend, resAppend, htmlAppend, jsAppend, cssAppend,
                htmlBody, jsBody, cssBody, htmlPrepend, jsPrepend, cssPrepend) {
                if (resBody != null) {
                  data.body = resBody || util.EMPTY_BUFFER;
                }
                if (resPrepend) {
                  data.top = resPrepend;
                }
                if (resAppend) {
                  data.bottom = util.toBuffer(resAppend);
                }

                var speedTransform = data.speed || data.delay ? new SpeedTransform(data) : null;
                delete data.headers;
                delete data.speed;
                delete data.delay;

                isHtml = isHtml || !headers['content-type'];
                if ((isHtml || type === 'JSON' || type === 'JS') && params && Object.keys(params).length) {
                  var transform = new Transform();
                  var interrupt;
                  var ctn = '';
                  transform._transform = function(text, encoding, callback) {
                    if (text) {
                      if (!interrupt) {
                        ctn += text;
                        text = null;
                        if ((isHtml && !LIKE_JSON_RE.test(ctn)) || Buffer.byteLength(ctn) > MAX_RES_SIZE) {
                          interrupt = true;
                          text = ctn;
                          ctn = null;
                        }
                      }
                    } else if (ctn) {
                      text = ctn.replace(JSON_RE, function(json) {
                        var obj = util.parseRawJson(json);
                        return obj ? JSON.stringify(extend(true, obj, params)) : json;
                      });
                      ctn = null;
                    } else if (!interrupt) {
                      try {
                        ctn = JSON.stringify(params);
                      } catch(e) {}
                      text = util.toBuffer(ctn);
                    }

                    callback(null, text);
                  };
                  res.addTextTransform(transform);
                }
                var top, body, bottom;
                switch(type) {
                case 'HTML':
                  top = cssPrepend;
                  body = cssBody;
                  bottom = cssAppend;
                  if (htmlPrepend) {
                    htmlPrepend = util.toBuffer(htmlPrepend, charset);
                    top = top ? Buffer.concat([top, htmlPrepend]) : htmlPrepend;
                  }
                  if (htmlBody) {
                    htmlBody = util.toBuffer(htmlBody, charset);
                    body = body ? Buffer.concat([body, htmlBody]) : htmlBody;
                  }
                  if (htmlAppend) {
                    htmlAppend = util.toBuffer(htmlAppend, charset);
                    bottom = bottom ? Buffer.concat([bottom, htmlAppend]) : htmlAppend;
                  }

                  if (jsPrepend) {
                    top = top ? Buffer.concat([top, jsPrepend]) : jsPrepend;
                  }
                  if (jsBody) {
                    body = body ? Buffer.concat([body, jsBody]) : jsBody;
                  }
                  if (jsAppend) {
                    bottom = bottom ? Buffer.concat([bottom, jsAppend]) : jsAppend;
                  }
                  top = top && Buffer.concat([DOCTYPE, top]);
                  break;
                case 'JS':
                  top = jsPrepend;
                  body = jsBody;
                  bottom =  jsAppend;
                  break;
                case 'CSS':
                  top = cssPrepend;
                  body = cssBody;
                  bottom =  cssAppend;
                  break;
                }

                if (top) {
                  top = util.toBuffer(top, charset);
                  data.top = data.top ? Buffer.concat([data.top, CRLF, top]) : Buffer.concat([top, CRLF]);
                }
                if (body) {
                  body = util.toBuffer(body, charset);
                  data.body = data.body ? Buffer.concat([data.body, CRLF, body]) : body;
                }
                if (bottom) {
                  bottom = util.toBuffer(bottom, charset);
                  data.bottom = data.bottom ? Buffer.concat([data.bottom, CRLF, bottom]) : Buffer.concat([CRLF, bottom]);
                }

                var hasData = data.body || data.top || data.bottom;
                if (hasData) {
                  !req.enable.keepCSP && util.disableCSP(headers);
                  !req._customCache && util.disableResStore(headers);
                  extend(headers, cusHeaders);
                }

                if (!hasResBody) {
                  delete data.speed;
                  delete data.body;
                  delete data.top;
                  delete data.bottom;
                } else {
                  util.removeResBody(req, data);
                }
                if (hasData || util.isWhistleTransformData(data)) {
                  if (isHtml) {
                    if (util.isEnable(req, 'strictHtml')) {
                      data.strictHtml = true;
                    } else {
                      data.safeHtml = util.isEnable(req, 'safeHtml');
                    }
                  }
                  res.addZipTransform(new WhistleTransform(data));
                }
                if (hasResBody) {
                  handleReplace(res, replacement);
                }
                //一定放在最后，确保能过滤到动态注入的内容
                if (speedTransform) {
                  res.add(speedTransform);
                }

                var bodyFile = hasResBody ? getWriterFile(util.getRuleFile(resRules.resWrite), _res.statusCode) : null;
                var rawFile = getWriterFile(util.getRuleFile(resRules.resWriteRaw), _res.statusCode);
                util.getFileWriters([bodyFile, rawFile], function(writer, rawWriter) {
                  res.on('src', function(_res) {
                    if (writer) {
                      res.addZipTransform(new FileWriterTransform(writer, _res));
                    }

                    if (rawWriter) {
                      res.addZipTransform(new FileWriterTransform(rawWriter, _res, true, req));
                    }
                  });
                  var delProps = util.parseDeleteProperties(req);
                  var resHeaders = delProps.resHeaders;
                  Object.keys(resHeaders).forEach(function(prop) {
                    delete headers[prop];
                  });
                  res.src(_res, null, firstChunk);
                  var rawNames = res.rawHeaderNames || {};

                  if (req.enable.gzip) {
                    rawNames['content-encoding'] = rawNames['content-encoding'] || 'Content-Encoding';
                    headers['content-encoding'] = 'gzip';
                    delete headers['content-length'];
                  } else if (req._pipePluginPorts.resReadPort || req._pipePluginPorts.resWritePort) {
                    delete req.headers['content-length'];
                  }
                  util.disableResProps(req, headers);
                  if (req.filter.showHost || req.enable.showHost) {
                    headers['x-host-ip'] = req.hostIp || LOCALHOST;
                  }
                  const ruleRaw = req.rules && req.rules.rule && req.rules.rule.raw;
                  _res.headers['__lightproxy-host-ip__'] = req.hostIp || LOCALHOST;

                  const strwrap = (str) => str.replace(/[^\x00-\x7F]/g, '_');

                  _res.headers['__lightproxy-rules__'] = strwrap(JSON.stringify(ruleRaw) || 'none');
                  _res.headers['__lightproxy-real-url__'] = strwrap(req.realUrl);

                  _res.headers['__lightproxy-help__'] = 'See https://github.com/alibaba/lightproxy';
                  // clientReady.then(() => {
                  //   wsClient.send(
                  //     'whistle-hit'.padEnd(50, ' ') +
                  //         JSON.stringify({
                  //           method: 'match-rule',
                  //           rule: ruleRaw,
                  //           hostip: req.hostIp,
                  //           host: req.get('host')
                  //         })
                  //   );
                  // })

                  util.setResponseFor(resRules, _res.headers, req, req.hostIp);
                  pluginMgr.postStats(req, res);
                  if (!hasResBody && headers['content-length'] > 0 && !util.isHead(req)) {
                    delete headers['content-length'];
                  }
                  if (!req.disable.trailerHeader) {
                    util.addTrailerNames(_res, newTrailers, rawNames, delProps.trailers, req);
                  }
                  try {
                    res.writeHead(_res.statusCode, formatHeaders(headers, rawNames));
                    util.onResEnd(_res, function() {
                      var trailers = _res.trailers;
                      if (!res.chunkedEncoding || req.disable.trailers || req.disable.trailer ||
                        (util.isEmptyObject(trailers) && util.isEmptyObject(newTrailers))) {
                        return;
                      }
                      var rawHeaderNames = _res.rawTrailers ? getRawHeaderNames(_res.rawTrailers) : {};
                      if (newTrailers) {
                        newTrailers = util.lowerCaseify(newTrailers, rawHeaderNames);
                        if (trailers) {
                          extend(trailers, newTrailers);
                        } else {
                          trailers = newTrailers;
                        }
                      }
                      var delTrailers = delProps.trailers;
                      Object.keys(delTrailers).forEach(function(prop) {
                        delete trailers[prop];
                      });
                      util.handleHeaderReplace(trailers, hr.trailer);
                      res.setCurTrailers && res.setCurTrailers(trailers, rawHeaderNames);
                      try {
                        util.removeIllegalTrailers(trailers);
                        res.addTrailers(formatHeaders(trailers, rawHeaderNames));
                      } catch (e) {}
                    });
                  } catch(e) {
                    e._resError = true;
                    util.emitError(res, e);
                  }
                });
              }, !hasResBody, charset, isHtml);
            });
          });
        });
      });
    });
  };

  var statusCode = util.getStatusCodeFromRule(resRules);
  var resHeaders = {};
  if (!statusCode && resRules.redirect) {
    statusCode = 302;
    resHeaders.Connection = 'close';
    resHeaders.location = util.getMatcherValue(resRules.redirect);
  }

  if (statusCode) {
    req.hostIp = LOCALHOST;
    resHeaders.Connection = 'close';
    res.response(util.wrapResponse({
      statusCode: statusCode,
      headers: util.handleStatusCode(statusCode, resHeaders)
    }));
    return;
  }

  notAllowCache(resRules) && util.disableReqCache(req.headers);
  if (!req.hasError) {
    next();
  }
};
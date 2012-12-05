var util = require('util')
  , httpUtil = require('../util/http')
  , filed = require('filed')
  , Resource = require('../resource')
  , path = require('path')
  , debug = require('debug')('dashboard')
  , fs = require('fs')
  , ejs = require('ejs')
  , keys = require('../keys')
  , async = require('async')
  , q = require('q');

function Dashboard() {
  // internal resource
  this.internal = true;

  this.loadLayout = async.memoize(this.loadLayout);
  this.loadLayout(function() {}); // Start loading it right away
  
  Resource.apply(this, arguments);
}
util.inherits(Dashboard, Resource);
module.exports = Dashboard;



Dashboard.prototype.handle = function(ctx, next) {
  var query = ctx.req.query;

  if (ctx.req.url === this.path) {
    return httpUtil.redirect(ctx.res, ctx.req.url + '/');
  } else if (ctx.url === '/deployments') {
    this.renderDeployments(ctx);
  } else if (ctx.url === '/__is-root') {
    ctx.done(null, {isRoot: ctx.req.isRoot});
  } else if (ctx.url.indexOf('/__custom') === 0) {
    this.serveCustomAsset(ctx, next);
  } else if (ctx.url.indexOf('.') !== -1) {
    filed(path.join(__dirname, 'dashboard', ctx.url)).pipe(ctx.res);  
  } else if (!ctx.req.isRoot && ctx.server.options.env !== 'development') {
    filed(path.join(__dirname, 'dashboard', 'auth.html')).pipe(ctx.res);  
  } else if (ctx.url.indexOf('/modules') === 0) {
    this.renderModulePage(ctx);
  } else {
    this.renderResourcePage(ctx);
  }
};


Dashboard.prototype.serveCustomAsset = function(ctx, next) {
  var parts = ctx.url.split('/').filter(function(p) { return p; })
    , resourceTypePath = parts[1]
    , resource = this;

  var types = this.server.resourceTypes;

  var resourceTypeId
    , resourceType
    , dashboardPath
    , reqUrl = parts.slice(2).join('/');

  resourceTypeId = Object.keys(types).filter(function(t) { return t.toLowerCase() === resourceTypePath; })[0];

  if (resourceTypeId) {
    resourceType = types[resourceTypeId];
    dashboardPath = resourceType && resourceType.prototype.dashboard && resourceType.prototype.dashboard.path;
    if (dashboardPath) {
      return filed(path.join(dashboardPath, reqUrl)).pipe(ctx.res); 
    }
  }

  next();
};

Dashboard.prototype.render = function(ctx, options) {
  var self = this;

  var layoutQ = q.ninvoke(self, 'loadLayout');

  var options = options || {};

  var context = options.context;

  context.env = ctx.server && ctx.server.options.env;
  context.appName = path.basename(path.resolve('./'));

  var render = {
    bodyHtml: options.bodyHtml
  };

  layoutQ.then(function(layout) {
    try {
      var rendered = layout({context: context, render: render, scripts: options.scripts || [], css: options.css || null});  
      ctx.res.setHeader('Content-Type', 'text/html; charset=UTF-8');
      ctx.res.end(rendered);
    } catch (ex) {
      ctx.done(ex.message);
    } 
  });
};

Dashboard.prototype.renderResourcePage = function(ctx) {
  var self = this;

  self.loadPage(ctx, function(err, options) {
    if (err) return ctx.done(ex.message);
    options = options || {};

    self.render(ctx, {
        bodyHtml: options.bodyHtml
      , scripts: options.scripts
      , css: options.css
      , context: {
          resourceId: options.resourceId
        , resourceType: options.resourceType
        , page: options.page
        , basicDashboard: options.basicDashboard
        , events: options.events
      }
    });
  });
};

// TODO: Refactor; shares too much logic with render()
Dashboard.prototype.renderDeployments = function(ctx) {
  var self = this
    , appName = path.basename(path.resolve('./'))
    , env = ctx.server && ctx.server.options.env;

  var layoutQ = q.ninvoke(this, 'loadLayout');
  var deploymentsPageQ = q.ninvoke(fs, 'readFile', path.join(__dirname, 'dashboard/deployments.html'), 'utf-8');

  q.spread([layoutQ, deploymentsPageQ], function(layout, deploymentsPage) {
    try {
      var rendered = layout({
        context: {
            page: 'Deployments'
          , module: 'App'
          , appName: appName
          , env: env
        },
        render: {bodyHtml: deploymentsPage},
        scripts: ['/js/deployments.js'],
        css: null
      });  
      ctx.res.setHeader('Content-Type', 'text/html; charset=UTF-8');
      ctx.res.end(rendered);
    } catch (ex) {
      ctx.done(ex.message);
    } 
  }, function(err) {
    ctx.done(err);
  });
};

Dashboard.prototype.loadLayout = function(fn) {
  var self = this;

  fs.readFile(path.join(__dirname, 'dashboard', 'index.ejs'), 'utf-8', function(err, layout) {
    if (err) return fn(err);
    var layoutTemplate = ejs.compile(layout, {open: '<{', close: '}>'}); //Avoid conlicts by using non-standard tags
    fn(null, layoutTemplate);
  });
};

Dashboard.prototype.loadPage = function(ctx, fn) {
  var parts = ctx.url.split('/').filter(function(p) { return p; })
    , resourceId
    , resource
    , resourceType
    , options = {}
    , self = this
    , dashboardPath
    , pagePath;

  if (parts.length) {
    resourceId = parts[0];
    resource = ctx.server.resources.filter(function(r) { 
      return r.name === resourceId.toLowerCase() 
    })[0];

    if (resource) {
      options.resourceId = resourceId;
      resourceType = resource.constructor;
      options.resourceType = resourceType.id;
      options.events = resource.eventNames;
      options.scripts = [];

      var page = parts[1];

      if (!page && resource.dashboard && resource.dashboard.pages) {
        page = resource.dashboard.pages[0];
      } else if (!page) {
        page = 'index';
      }
      if (page === 'config') page = 'index';

      dashboardPath = resource.dashboard && resource.dashboard.path; 

      async.waterfall([
        function(fn) {
          if (dashboardPath) {
            pagePath = path.join(dashboardPath, page + '.html');
            fs.exists(pagePath, function(exists) {
              fn(null, exists);
            });  
          } else {
            fn(null, false);
          }
        },

        function(exists, fn) {
          if (exists) {
            self.loadAdvancedDashboard({
                pagePath: pagePath
              , dashboardPath: dashboardPath
              , page: page
              , resourceType: resourceType
              , resource: resource
              , options: options
            }, fn);
          } else {
            self.loadBasicDashboard({
                options: options
              , page: page
              , resource: resource
              , resourceType: resourceType
            }, fn);
          }
        }
      ], function(err) {
        fn(err, options);
      });

      debug("Editing resource %s of type %s", resourceId, resourceType.id);

      return;
    }
  }

  fn(); //blank page
};

Dashboard.prototype.loadAdvancedDashboard = function(data, fn) {
  var pagePath = data.pagePath
    , dashboardPath = data.dashboardPath
    , page = data.page
    , resourceType = data.resourceType
    , resource = data.resource
    , options = data.options;


  async.parallel({
    bodyHtml: function(fn) {
      fs.readFile(pagePath, 'utf-8', fn);
    },

    scripts: function(fn) {
      if (resource.dashboard.scripts) {
        resource.dashboard.scripts.forEach(function(s) {
          options.scripts.push('/__custom/' + resourceType.id.toLowerCase() + s);
        });
      }

      fs.exists(path.join(dashboardPath, 'js', page + '.js'), function(exists) {
        if (exists) {
          options.scripts.push('/__custom/' + resourceType.id.toLowerCase() + '/js/' + page + '.js');
        }

        fn();
      });
    },

    stylesheet: function(fn) {
      fs.exists(path.join(resource.dashboard.path, 'style.css'), function(exists) {
        if (exists) {
          options.css = '/__custom/' + resourceType.id.toLowerCase() + '/style.css';
        }

        fn();
      });
    }
  }, function(err, results) {
    if (err) return fn(err);

    options.bodyHtml = results.bodyHtml;

    if (page === 'index') page = 'config';
    options.page = page;

    fn(null, options);
  });
};

Dashboard.prototype.loadBasicDashboard = function(data, fn) {
  var options = data.options
    , page = data.page
    , resourceType = data.resourceType
    , resource = data.resource
    , dashboardPath = path.join(__dirname, 'dashboard');

  options.page = page;
  if (page === 'index') {
    options.page = 'config';
    if (resource.basicDashboard) {
      options.scripts.push('/js/basic.js');
      options.basicDashboard = resource.basicDashboard;
      fs.readFile(path.join(dashboardPath, 'basic.html'), function(err, bodyHtml) {
        options.bodyHtml = bodyHtml;
        fn(err);
      });
    } else {
      options.scripts.push('/js/default.js');
      fs.readFile(path.join(dashboardPath, 'default.html'), function(err, bodyHtml) {
        options.bodyHtml = bodyHtml;
        fn(err);
      });
    }
  } else if (page === 'events') {
    fs.readFile(path.join(dashboardPath, 'events.html'), function(err, bodyHtml) {
      options.bodyHtml = bodyHtml;
      fn(err);
    });
  } else {
    return fn();
  }
};
/**
 * CSInterface.js — Adobe CEP Bridge (minimal production build)
 * Based on Adobe CEP Resources — https://github.com/Adobe-CEP/CEP-Resources
 */
'use strict';

var SystemPath = {
  APPLICATION:  'application',
  EXTENSION:    'extension',
  DOCUMENT:     'document',
  HOME:         'home',
  TEMP:         'tmp',
  HOST_APPLICATION: 'hostApplication'
};

var ColorType = { CUSTOM: 'custom', GRADIENT: 'gradient', NONE: 'none' };

var CSEvent = function(type, scope, appId, extensionId) {
  this.type        = type;
  this.scope       = scope || 'APPLICATION';
  this.appId       = appId || '';
  this.extensionId = extensionId || '';
  this.data        = '';
};

var CSInterface = (function() {
  function CSInterface() {
    this._hostEnvironment = null;
    this._hostEnvironmentStr = '';

    if (window.__adobe_cep__) {
      this._hostEnvironmentStr = window.__adobe_cep__.getHostEnvironment();
      this._hostEnvironment    = JSON.parse(this._hostEnvironmentStr);
    } else {
      // Fallback for dev outside CEP
      this._hostEnvironment = { appId: 'PPRO', appVersion: '14.0', appLocale: 'en_US', appName: 'Premiere Pro' };
    }

    this.hostEnvironment = this._hostEnvironment;
  }

  CSInterface.prototype.getHostEnvironment = function() {
    return this._hostEnvironment;
  };

  CSInterface.prototype.evalScript = function(script, callback) {
    if (!callback) callback = function() {};
    if (window.__adobe_cep__) {
      window.__adobe_cep__.evalScript(script, callback);
    } else {
      console.warn('[CSInterface] evalScript called outside CEP:', script.substring(0, 80));
      callback('{"error":"Not in CEP context"}');
    }
  };

  CSInterface.prototype.getSystemPath = function(pathType) {
    if (!window.__adobe_cep__) return '';
    var path = decodeURIComponent(window.__adobe_cep__.getSystemPath(pathType));
    if (this.getOSInformation().indexOf('Windows') >= 0) {
      path = path.replace('file:///', '');
    } else {
      path = path.replace('file://', '');
    }
    return path;
  };

  CSInterface.prototype.getOSInformation = function() {
    if (typeof navigator !== 'undefined') {
      if (navigator.userAgent.indexOf('Windows') >= 0) return 'Windows';
      if (navigator.userAgent.indexOf('Mac')     >= 0) return 'macOS';
    }
    return 'Unknown';
  };

  CSInterface.prototype.addEventListener = function(type, listener) {
    if (window.__adobe_cep__) {
      window.__adobe_cep__.addEventListener(type, listener);
    }
  };

  CSInterface.prototype.dispatchEvent = function(event) {
    if (window.__adobe_cep__) {
      window.__adobe_cep__.dispatchEvent(event);
    }
  };

  CSInterface.prototype.openURLInDefaultBrowser = function(url) {
    if (window.cep && window.cep.util) {
      window.cep.util.openURLInDefaultBrowser(url);
    } else if (window.__adobe_cep__) {
      window.__adobe_cep__.openURLInDefaultBrowser(url);
    } else {
      window.open(url, '_blank');
    }
  };

  return CSInterface;
})();

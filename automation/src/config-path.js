const fs = require('fs');
const path = require('path');

// 配置分两层：config/ 下是可公开的示例，config/private/（Git 忽略）放本人真实画像与检索计划。
// 运行时优先读取 private；测试设置 JOB_TRACKER_CONFIG=example 强制只用公开示例。
const CONFIG_DIR = process.env.TRACKER_CONFIG_DIR || path.join(__dirname, '..', 'config');
const PRIVATE_DIR = process.env.JOB_TRACKER_PRIVATE_CONFIG_DIR || path.join(CONFIG_DIR, 'private');

function configPath(name) {
  if (process.env.JOB_TRACKER_CONFIG !== 'example') {
    const privatePath = path.join(PRIVATE_DIR, name);
    if (fs.existsSync(privatePath)) return privatePath;
  }
  return path.join(CONFIG_DIR, name);
}

function readConfigJson(name) {
  return JSON.parse(fs.readFileSync(configPath(name), 'utf8'));
}

function readConfigText(name) {
  return fs.readFileSync(configPath(name), 'utf8');
}

module.exports = { CONFIG_DIR, PRIVATE_DIR, configPath, readConfigJson, readConfigText };

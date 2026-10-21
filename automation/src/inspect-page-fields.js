#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { connectCdpBrowser } = require('./cdp-connection');
const bossAdapter = require('./adapters/boss');

const [, , source, url] = process.argv;
if (!['boss', 'liepin'].includes(source) || !url) {
  console.error('用法: node src/inspect-page-fields.js boss|liepin URL');
  process.exit(1);
}

async function main() {
  const browser = await connectCdpBrowser({ port: 18800 });
  const page = await browser.newPage();

  const outputDir = path.resolve(__dirname, '..', '..', 'data', 'field-inspection');
  fs.mkdirSync(outputDir, { recursive: true });
  try {
    if (source === 'boss') {
      // BOSS 直接从空白页跳详情可能触发页面终止；审计也遵循正式的“列表→详情”路径。
      await bossAdapter.search(page, '数据产品项目经理', { city: '101010100', maxPages: 1 });
      await bossAdapter.detail(page, { url });
    } else {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(resolve => setTimeout(resolve, 1500));
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(resolve => setTimeout(resolve, 500));

    const data = await page.evaluate(() => {
      const visible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const ownText = element => Array.from(element.childNodes)
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent.trim()).filter(Boolean).join(' ');
      const elements = Array.from(document.body.querySelectorAll('*')).filter(visible);
      const leafFields = elements.map(element => ({
        tag: element.tagName.toLowerCase(),
        className: typeof element.className === 'string' ? element.className : '',
        text: ownText(element)
      })).filter(item => item.text.length >= 2 && item.text.length <= 240).slice(0, 1500);
      const semanticBlocks = elements.map(element => ({
        tag: element.tagName.toLowerCase(),
        className: typeof element.className === 'string' ? element.className : '',
        text: (element.innerText || '').trim()
      })).filter(item => /job|boss|recruit|company|tag|salary|time|degree|experience|education|people|number|property|info/i.test(item.className)
        && item.text.length >= 2 && item.text.length <= 1200).slice(0, 500);
      const diagnosticMatches = elements.filter(element => /人力资源服务许可证|B端产品|C端产品|猎头顾问|HRBP|页面更新时间|更新时间：/.test(element.innerText || ''))
        .filter(element => (element.innerText || '').trim().length <= 120)
        .slice(0, 100)
        .map(element => ({
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === 'string' ? element.className : '',
          text: (element.innerText || '').replace(/\s+/g, ' ').trim(),
          parent: element.parentElement ? {
            tag: element.parentElement.tagName.toLowerCase(),
            className: typeof element.parentElement.className === 'string' ? element.parentElement.className : '',
            text: (element.parentElement.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)
          } : null,
          grandparent: element.parentElement?.parentElement ? {
            tag: element.parentElement.parentElement.tagName.toLowerCase(),
            className: typeof element.parentElement.parentElement.className === 'string' ? element.parentElement.parentElement.className : '',
            text: (element.parentElement.parentElement.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500)
          } : null
        }));
      return {
        url: location.href,
        title: document.title,
        bodyText: document.body.innerText,
        leafFields,
        semanticBlocks,
        diagnosticMatches
      };
    });

    const stem = `${source}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const screenshotPath = path.join(outputDir, `${stem}.png`);
    const jsonPath = path.join(outputDir, `${stem}.json`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    console.log(JSON.stringify({ screenshotPath, jsonPath, url: data.url, title: data.title, bodyLength: data.bodyText.length }, null, 2));
  } finally {
    await page.close().catch(() => {});
    await browser.disconnect();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

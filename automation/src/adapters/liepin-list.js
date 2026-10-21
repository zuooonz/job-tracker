// Small HTML-fixture parser kept independent of a browser so list-card drift can be tested offline.
function decode(value = '') {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}
function textOf(markup = '') { return decode(markup.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }

function parseLiepinListHtml(html) {
  const starts = [...String(html).matchAll(/<div\b([^>]*\bjobCardPcContainer\b[^>]*)>/gi)];
  const cards = starts.map((match, index) => {
    const start = match.index;
    const end = starts[index + 1]?.index ?? html.length;
    const chunk = html.slice(start, end);
    if (/\bdisplay\s*:\s*none/i.test(match[1]) || /\bvisibility\s*:\s*hidden/i.test(match[1])) return null;
    const link = chunk.match(/<a\b(?=[^>]*\bdata-nick="job-detail-job-info")([^>]*?)>/i)
      || chunk.match(/<a\b[^>]*href="([^"]*\/job\/[^\"]+|[^\"]*\/a\/[^\"]+)"[^>]*>/i);
    const href = decode((link?.[0] || '').match(/\bhref="([^"]+)"/i)?.[1] || '');
    const titleBox = chunk.match(/<div\b[^>]*\bjobTitleBox\b[^>]*>([\s\S]*?)<\/div>\s*<span/i)?.[1] || '';
    const titleMatch = titleBox.match(/<div\b[^>]*class="[^"]*ellipsis-1[^"]*"[^>]*title="([^"]+)"[^>]*>([\s\S]*?)<\/div>/i);
    const title = textOf(titleMatch?.[2] || '') || decode(titleMatch?.[1] || '');
    const city = textOf(titleBox).match(/【\s*([^】]+?)\s*】/)?.[1] || '';
    const company = decode(chunk.match(/<span\b[^>]*\bcompanyName\b[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '').replace(/<[^>]*>/g, '').trim();
    const salary = decode((chunk.match(/<span\b[^>]*>([^<]*(?:k(?:\/月)?|万(?:\/月)?|元\/天)[^<]*)<\/span>/i) || [])[1] || '').trim();
    if (!title || !href || !/liepin\.com\/(?:.*\/)?(?:job|a)\//.test(href)) return null;
    return { title, location: textOf(city), salary, company: textOf(company) || '未披露', url: href };
  });
  return cards.filter(Boolean);
}

module.exports = { parseLiepinListHtml };

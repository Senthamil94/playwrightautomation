const fs = require('fs');
const xlsx = require('xlsx');

function loadCredentials(workbookPath) {
  if (!fs.existsSync(workbookPath)) {
    throw new Error(`Missing credentials file: ${workbookPath}`);
  }

  const workbook = xlsx.readFile(workbookPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

  return rows
    .map((row, index) => {
      const name = String(
        row['Restaurant Name'] || row.name || row.Name || row.restaurant || ''
      ).trim();
      const url = String(
        row.url || row.URL || row['Admin URL'] || row.site || row.Site || ''
      ).trim();
      const username = String(
        row.username || row.Username || row['User Name'] || row.user || row.User || ''
      ).trim();
      const password = String(
        row.password || row.Password || row.pass || row.Pass || ''
      ).trim();

      return {
        row: index + 1,
        name: name || `Row ${index + 1}`,
        url,
        username,
        password,
      };
    })
    .filter((record) => record.url && record.username && record.password);
}

module.exports = { loadCredentials };

const crcTable = (() => { const table = new Uint32Array(256); for (let index = 0; index < 256; index += 1) { let value = index; for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; table[index] = value >>> 0; } return table; })();
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function dosDateTime(date = new Date()) { const year = Math.max(1980, date.getFullYear()); return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2), date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() }; }
function u16(value) { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value & 0xffff); return buffer; }
function u32(value) { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value >>> 0); return buffer; }

export function createZip(files) {
  const local = [], central = []; let offset = 0; const stamp = dosDateTime();
  for (const file of files) {
    const name = Buffer.from(file.name.replaceAll('\\', '/')); const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content)); const crc = crc32(data);
    const header = Buffer.concat([u32(0x04034b50),u16(20),u16(0x0800),u16(0),u16(stamp.time),u16(stamp.date),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),name]); local.push(header,data);
    central.push(Buffer.concat([u32(0x02014b50),u16(20),u16(20),u16(0x0800),u16(0),u16(stamp.time),u16(stamp.date),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name])); offset += header.length + data.length;
  }
  const centralBuffer = Buffer.concat(central); const end = Buffer.concat([u32(0x06054b50),u16(0),u16(0),u16(files.length),u16(files.length),u32(centralBuffer.length),u32(offset),u16(0)]); return Buffer.concat([...local,centralBuffer,end]);
}

const xmlEscape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
function columnName(index) { let name = ''; for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name; return name; }
function worksheetXml(rows) {
  const body = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => { const ref = `${columnName(columnIndex)}${rowIndex + 1}`; if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${rowIndex === 0 ? ' s="1"' : ''}><v>${value}</v></c>`; return `<c r="${ref}" t="inlineStr"${rowIndex === 0 ? ' s="1"' : ''}><is><t>${xmlEscape(value)}</t></is></c>`; }).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${body}</sheetData><autoFilter ref="A1:${columnName(Math.max(0,(rows[0]?.length || 1)-1))}${Math.max(1,rows.length)}"/></worksheet>`;
}

export function createXlsx(sheets) {
  const safe = sheets.map((sheet, index) => ({ ...sheet, name: String(sheet.name || `Sheet ${index + 1}`).replace(/[\\/*?:\[\]]/g,' ').slice(0,31) }));
  const files = [
    { name: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${safe.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${safe.map((sheet,i)=>`<sheet name="${xmlEscape(sheet.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${safe.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${safe.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>' },
    ...safe.map((sheet,i)=>({ name:`xl/worksheets/sheet${i+1}.xml`, content:worksheetXml(sheet.rows || []) }))
  ]; return createZip(files);
}

function pdfEscape(value) { return String(value).replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)'); }
export function createSimplePdf(title, lines) {
  const wrapped = [title,'',...lines].flatMap(line => { const words=String(line).split(/\s+/), out=[]; let current=''; for(const word of words){ if((current+' '+word).trim().length>92){out.push(current);current=word}else current=(current+' '+word).trim(); } out.push(current); return out; }); const pages=[]; for(let i=0;i<wrapped.length;i+=48) pages.push(wrapped.slice(i,i+48));
  const objects=[]; const add=value=>{objects.push(value);return objects.length}; const fontId=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); const pageIds=[]; const contentIds=[];
  for(const pageLines of pages){ const stream=`BT /F1 10 Tf 50 760 Td 13 TL ${pageLines.map((line,index)=>`${index?'T* ':''}(${pdfEscape(line)}) Tj`).join(' ')} ET`; contentIds.push(add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)); pageIds.push(add('PENDING')); }
  const pagesId=objects.length+1; add(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] >>`); for(let i=0;i<pageIds.length;i++) objects[pageIds[i]-1]=`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`; const catalogId=add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let output='%PDF-1.4\n'; const offsets=[0]; objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(output));output+=`${index+1} 0 obj\n${object}\nendobj\n`;}); const xref=Buffer.byteLength(output); output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length+1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`; return Buffer.from(output);
}

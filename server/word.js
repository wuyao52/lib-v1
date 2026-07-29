import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';

const extractor = new WordExtractor();
const MAX_EXTRACTED_CHARACTERS = 200_000;

function cleanExtractedText(value) {
  const text = String(value || '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) throw new Error('Word 文件中没有可读取的正文');
  if (text.length > MAX_EXTRACTED_CHARACTERS) throw new Error('Word 正文不能超过 200000 字');
  return text;
}

export async function extractWordText(buffer, extension) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Word 文件内容为空');
  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return cleanExtractedText(result.value);
  }
  if (extension === '.doc') {
    const document = await extractor.extract(buffer);
    return cleanExtractedText(document.getBody());
  }
  throw new Error('仅支持 DOC 和 DOCX 文件');
}

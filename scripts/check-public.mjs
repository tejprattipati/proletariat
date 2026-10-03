import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
const files=[...new Set(execFileSync("git",["ls-files","--cached","--others","--exclude-standard","-z"],{encoding:"utf8"}).split("\0").filter(Boolean))];
const forbidden=/(^|\/)(\.env(?:\..*)?|\.data|private|research|attachments|node_modules)(\/|$)|\.(pem|key|sqlite(?:-wal|-shm)?|db)$/i;
const patterns=[
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|github_pat|sk-proj)[_-][A-Za-z0-9_\-]{20,}/,
  /\bAIza[A-Za-z0-9_-]{30,}/,
  /\bya29\.[A-Za-z0-9_.-]{20,}/,
  /https:\/\/docs\.google\.com\/(?:document|spreadsheets)\/d\/[A-Za-z0-9_-]{25,}/,
  /[A-Za-z0-9._%+-]+@(?:umich\.edu)/i,
];
const failures=[];
for(const file of files){
  if(file===".env.example")continue;
  if(forbidden.test(file)){failures.push(`${file}: forbidden public path`);continue;}
  if(!statSync(file).isFile()||statSync(file).size>2_000_000)continue;
  const content=readFileSync(file,"utf8");
  if(patterns.some(pattern=>pattern.test(content)))failures.push(`${file}: possible private content or credential`);
}
if(failures.length){console.error(failures.join("\n"));process.exit(1);}
console.log(`Public-file checks passed for ${files.length} files. Review diffs before publishing; pattern checks cannot prove absence of every secret.`);

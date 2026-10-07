import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {win32} from 'node:path';
test('Windows project URLs and public-file containment avoid duplicated drives',()=>{
 const root=fileURLToPath(new URL('.', 'file:///C:/Users/shara/Downloads/FINTRACK/fintrack/server.mjs'),{windows:true});
 assert.equal(root,'C:\\Users\\shara\\Downloads\\FINTRACK\\fintrack\\');
 const pub=win32.resolve(root,'public'),file=win32.resolve(pub,'app.js'),rel=win32.relative(pub,file);
 assert.equal(rel,'app.js');assert.equal(win32.isAbsolute(rel),false);assert.equal(rel.startsWith('..'+win32.sep),false);
 const escape=win32.relative(pub,win32.resolve(pub,'..','data','fintrack.sqlite'));
 assert.equal(escape.startsWith('..'+win32.sep),true);
 const encoded=fileURLToPath(new URL('.', 'file:///C:/Users/My%20Name/FINTRACK/server.mjs'),{windows:true});
 assert.equal(encoded,'C:\\Users\\My Name\\FINTRACK\\');
});

import {zipFunctions} from '@netlify/zip-it-and-ship-it';import {mkdirSync} from 'node:fs';
mkdirSync('.netlify/functions-check',{recursive:true});const functions=await zipFunctions('netlify/functions','.netlify/functions-check',{archiveFormat:'zip',nodeVersion:'22',config:{'*':{nodeBundler:'esbuild',externalNodeModules:['pg','exceljs','pdfkit','papaparse']}}});
for(const f of functions)console.log(JSON.stringify({name:f.name,runtime:f.runtime,bundler:f.bundler,path:f.path}));

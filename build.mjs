import {build} from 'esbuild';
await build({entryPoints:['src/app.jsx'],bundle:true,outdir:'public',minify:true,sourcemap:true,loader:{'.jsx':'jsx'},define:{'process.env.NODE_ENV':'"production"'}});
console.log('FINTRACK frontend built.');

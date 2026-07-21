import { query } from './scripts/overpass.mjs'
const q = `[out:json][timeout:150];
(relation(id:9504526,11065584,11065585,5392090);
 relation["type"="route"]["route"="train"]["name"~"京葉線"];
)->.r;
.r out tags;

// mongo-client.js
// Browser-side shim — proxies all aggregate calls through your Express backend.
// The same server.js from Query 6 works here unchanged.
//
// If you're running server-side (Node/SSR), replace this file with a real
// MongoDB driver wrapper:
//
//   import { MongoClient } from 'mongodb';
//   export async function mongoAggregate(uri, db, collection, pipeline) {
//     const client = new MongoClient(uri);
//     await client.connect();
//     const result = await client.db(db).collection(collection).aggregate(pipeline).toArray();
//     await client.close();
//     return result;
//   }

const API_BASE = '';   // empty = same origin; set to 'http://localhost:3000' if needed

/**
 * Run a MongoDB aggregation via the Express proxy at POST /api/aggregate.
 * @param {string}   uri        MongoDB URI
 * @param {string}   db         Database name
 * @param {string}   collection Collection name
 * @param {Array}    pipeline   Aggregation pipeline
 * @returns {Promise<Array>}    Array of result documents
 */
export async function mongoAggregate(uri, db, collection, pipeline) {
  const res = await fetch(`${API_BASE}/api/aggregate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ uri, db, collection, pipeline }),
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Aggregate failed (HTTP ${res.status}): ${msg}`);
  }

  return res.json();
}

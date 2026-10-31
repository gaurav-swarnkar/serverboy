// "Connect" tab of a MongoDB collection: how to use the database from code and web pages.
// (APIs are managed on their own page: Hosting → APIs.)
import { esc } from '../ui.js';

// ======================= Connect tab =======================

export function mountConnectGuide(el, server, dbName, col) {
  const model = col.charAt(0).toUpperCase() + col.slice(1).replace(/s$/, '');
  el.innerHTML = `
    <div class="notice"><b>There are two ways to use <span class="mono">${esc(dbName)}</span> from your project.</b> Most SaaS apps use both: the backend talks to MongoDB directly, and web pages talk to the backend or to the Data API.</div>
    <div class="grid grid-2" style="align-items:start;margin-bottom:16px">
      <div class="card">
        <h3>1. From your backend (Node.js, Express, Next.js)</h3>
        <p class="small muted" style="margin-top:0">Fastest and most flexible. Your server code connects with a username and password; browsers never see them.</p>
        <ol class="small" style="padding-left:18px">
          <li>Click <b>Users</b> (top of the MongoDB page) → <b>+ New app user</b> with database <span class="mono">${esc(dbName)}</span>. Copy the <span class="mono">MONGODB_URI</span> it shows.</li>
          <li>Put it in your app's environment variables (Node Apps → Env).</li>
          <li>Use it in code:</li>
        </ol>
        <pre class="log">${esc(`// npm install mongodb
const { MongoClient, ObjectId } = require("mongodb");
const client = new MongoClient(process.env.MONGODB_URI);
const db = client.db("${dbName}");

// find, create, update, delete
const items = await db.collection("${col}").find({ status: "active" }).limit(20).toArray();
const { insertedId } = await db.collection("${col}").insertOne({ name: "New", createdAt: new Date() });
await db.collection("${col}").updateOne({ _id: new ObjectId(id) }, { $set: { name: "Renamed" } });
await db.collection("${col}").deleteOne({ _id: new ObjectId(id) });`)}</pre>
        <details><summary class="small"><b>Using Mongoose instead</b></summary><pre class="log">${esc(`// npm install mongoose
const mongoose = require("mongoose");
await mongoose.connect(process.env.MONGODB_URI);

const ${model} = mongoose.model("${model}", new mongoose.Schema({
  name: { type: String, required: true },
}, { timestamps: true }), "${col}");

const items = await ${model}.find().sort({ createdAt: -1 }).limit(20);`)}</pre></details>
      </div>
      <div class="card">
        <h3>2. From web pages (HTML, React, mobile apps)</h3>
        <p class="small muted" style="margin-top:0">Browsers cannot connect to MongoDB directly (and must never get the password). Make an <b>API</b> for it (Hosting → APIs): a web address with exactly the actions you allow.</p>
        <ol class="small" style="padding-left:18px">
          <li>Open <a href="#/s/${server.id}/apis/new/${encodeURIComponent(dbName)}/${encodeURIComponent(col)}">Hosting → APIs → + New API</a> and choose <span class="mono">${esc(col)}</span>.</li>
          <li>Let <b>anyone</b> see the data if it is public; keep adding and changing for <b>apps with a key</b>.</li>
          <li>Call it from your page:</li>
        </ol>
        <pre class="log">${esc(`<ul id="list"></ul>
<script>
  fetch("https://YOUR-API-ADDRESS/api/${col.toLowerCase()}?limit=20")
    .then((r) => r.json())
    .then(({ data }) => {
      document.getElementById("list").innerHTML =
        data.map((item) => "<li>" + item.name + "</li>").join("");
    });
</script>`)}</pre>
        <p class="small muted">Saving data from a page (forms, sign-ups): send it to <b>your backend</b>, which checks it and then writes using the database or an API key. A key inside page code can be copied by anyone.</p>
      </div>
    </div>
    <div class="card">
      <h3>Which should I use?</h3>
      <table class="small"><thead><tr><th></th><th>Direct connection (1)</th><th>Data API (2)</th></tr></thead><tbody>
        <tr><td>Where it runs</td><td>Your server code only</td><td>Anywhere: browsers, mobile apps, other servers</td></tr>
        <tr><td>What you can do</td><td>Everything MongoDB can (aggregations, transactions…)</td><td>List / filter / get / create / update / delete</td></tr>
        <tr><td>Security</td><td>Password stays on the server</td><td>You choose per action: off, public, or key</td></tr>
        <tr><td>Good for</td><td>Your SaaS backend, business logic, logins</td><td>Public catalogs, dashboards, quick prototypes, other apps</td></tr>
      </tbody></table>
      <h4>Checklist before going live</h4>
      <ul class="small" style="padding-left:18px;margin:0">
        <li>MongoDB authentication is on (<b>Secure MongoDB</b>) and each app has its own database user.</li>
        <li>Passwords, connection strings and keys are in environment variables, never in Git.</li>
        <li>Hide fields like passwords or internal notes in the API (What it can do → Fields), and allow only the websites that should call it (Settings → CORS).</li>
        <li>Back up the database regularly (Command book → MongoDB → Back up a database).</li>
      </ul>
    </div>`;
}

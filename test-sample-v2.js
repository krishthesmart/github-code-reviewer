const express = require("express");
const mysql = require("mysql");
const app = express();

// Hardcoded credentials
const DB_PASSWORD = "admin123";
const API_KEY = "sk-live-abc123secret";

const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: DB_PASSWORD,
  database: "users",
});

// SQL injection vulnerability
app.get("/user", (req, res) => {
  const id = req.query.id;
  const query = "SELECT * FROM users WHERE id = " + id;
  db.query(query, (err, results) => {
    res.json(results);
  });
});

// XSS vulnerability
app.get("/greet", (req, res) => {
  const name = req.query.name;
  res.send("<h1>Hello " + name + "</h1>");
});

// No auth check on destructive endpoint
app.delete("/admin/delete-all", (req, res) => {
  db.query("DELETE FROM users", () => {
    res.send("All users deleted");
  });
});

// Password logged in plaintext
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  console.log("Login attempt:", username, password);
  res.send("ok");
});

app.listen(3000);

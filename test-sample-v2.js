const express = require("express");
const mysql = require("mysql2/promise");
const helmet = require("helmet");
const dotenv = require("dotenv");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

dotenv.config();

const app = express();
app.use(express.json());
app.use(helmet());

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: true,
    ca: process.env.DB_SSL_CERT,
  },
};

async function connectToDatabase() {
  try {
    const db = await mysql.createConnection(dbConfig);
    console.log("Connected to database");
    return db;
  } catch (error) {
    console.error("Error connecting to database:", error);
    process.exit(1);
  }
}

const db = connectToDatabase();

app.get("/user", async (req, res) => {
  try {
    const id = req.query.id;
    const [results] = await (await db).execute("SELECT * FROM users WHERE id = ?", [id]);
    res.json(results);
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/greet", (req, res) => {
  const name = req.query.name;
  const encodedName = encodeURIComponent(name);
  res.send(`<h1>Hello ${encodedName}</h1>`);
});

app.delete("/admin/delete-all", authenticateAdmin, async (req, res) => {
  try {
    await (await db).execute("DELETE FROM users");
    res.send("All users deleted");
  } catch (error) {
    console.error("Error deleting users:", error);
    res.status(500).send("Internal Server Error");
  }
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const [user] = await (await db).execute("SELECT * FROM users WHERE username = ?", [username]);
    if (!user) {
      res.status(401).send("Invalid username or password");
      return;
    }
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      res.status(401).send("Invalid username or password");
      return;
    }
    const token = jwt.sign({ userId: user.id }, process.env.SECRET_KEY, { expiresIn: "1h" });
    res.send({ token });
  } catch (error) {
    console.error("Error logging in:", error);
    res.status(500).send("Internal Server Error");
  }
});

function authenticateAdmin(req, res, next) {
  const token = req.header("Authorization");
  if (!token) {
    res.status(401).send("Unauthorized");
    return;
  }
  try {
    const decoded = jwt.verify(token, process.env.SECRET_KEY);
    if (decoded.userId !== 1) {
      res.status(403).send("Forbidden");
      return;
    }
    next();
  } catch (error) {
    console.error("Error authenticating admin:", error);
    res.status(401).send("Unauthorized");
  }
}

app.listen(3000);
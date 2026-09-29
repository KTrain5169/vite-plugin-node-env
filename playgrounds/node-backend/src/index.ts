import express from "express";

const app = express();

app.get("/", (_req, res) => {
  res.status(200);
  res.end("It works!");
});

export default app;

const express = require('express');
const cors = require('cors');
const path = require('path');
const editRouter = require('./routes/edit');
const videoRouter = require('./routes/video');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', editRouter);
app.use('/api/video', videoRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Image edit API running on port ${PORT}`);
});

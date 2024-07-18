const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Supabase setup
const supabaseUrl = 'https://kgoxnhqzegmrpmmcuedr.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtnb3huaHF6ZWdtcnBtbWN1ZWRyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcyMTMyNDkzMCwiZXhwIjoyMDM2OTAwOTMwfQ.ZzOygCfdj2bsoNSBZSjh_iMjMU8hL0LU6DVX-PPts4c';
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve the index.html file at the root URL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Register endpoint
app.post('/register', async (req, res) => {
    const { email, password } = req.body;
    const { user, error } = await supabase.auth.signUp({ email, password });

    if (error) {
        return res.status(400).json({ error: error.message });
    }

    res.status(200).json({ message: 'User registered successfully', user });
});

// Login endpoint
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const { session, error } = await supabase.auth.signIn({ email, password });

    if (error) {
        return res.status(400).json({ error: error.message });
    }

    res.status(200).json({ message: 'User logged in successfully', session });
});

// Chat endpoint (for simplicity, we'll just echo messages)
app.post('/chat', async (req, res) => {
    const { message } = req.body;
    res.status(200).json({ message: `You said: ${message}` });
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
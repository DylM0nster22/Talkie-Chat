require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({ 
    secret: 'secret', 
    resave: false, 
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if using HTTPS
}));
app.use(passport.initialize());
app.use(passport.session());

// Passport configuration
passport.use(new LocalStrategy(
    async (username, password, done) => {
        try {
            const res = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
            if (res.rows.length === 0) {
                return done(null, false, { message: 'Incorrect username.' });
            }
            const user = res.rows[0];
            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) {
                return done(null, false, { message: 'Incorrect password.' });
            }
            return done(null, user);
        } catch (err) {
            return done(err);
        }
    }
));

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const res = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
        done(null, res.rows[0]);
    } catch (err) {
        done(err);
    }
});

// Routes to serve HTML files
app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Routes for registration and login
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    try {
        await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashedPassword]);
        res.redirect('/login');
    } catch (err) {
        console.error('Error registering new user:', err); // Log the error details
        res.status(500).send('Error registering new user.');
    }
});

app.post('/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) {
            console.error('Error during login:', err); // Log the error details
            return next(err);
        }
        if (!user) {
            console.error('Login failed:', info.message); // Log the failure message
            return res.redirect('/login');
        }
        req.logIn(user, (err) => {
            if (err) {
                console.error('Error logging in user:', err); // Log the error details
                return next(err);
            }
            return res.redirect('/');
        });
    })(req, res, next);
});

app.get('/logout', (req, res) => {
    req.logout();
    res.redirect('/');
});

io.on('connection', (socket) => {
    console.log('New user connected');
    socket.on('chat message', (msg) => {
        io.emit('chat message', msg);
    });
    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
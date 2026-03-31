const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

dotenv.config();

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'energy-compliance-secret-key-2026';
const JWT_EXPIRES_IN = '30d';

// Configuración de la conexión a Supabase
const poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('supabase.co') 
      ? { rejectUnauthorized: false } 
      : false
};

console.log('========================================');
console.log('DEBUG - Configuración de Base de Datos:');
console.log('DATABASE_URL configurada:', process.env.DATABASE_URL ? 'SÍ (Existe)' : 'NO (Vacía)');
if (process.env.DATABASE_URL) {
    console.log('URL empieza con:', process.env.DATABASE_URL.substring(0, 20) + '...');
}
console.log('Modo SSL:', JSON.stringify(poolConfig.ssl));
console.log('========================================');

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
    console.error('DEBUG - Error inesperado en el Pool de Postgres:', err);
});

// Configuración CORS explícita
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://energy-compliance.vercel.app',
    'https://energy-compliance-git-main.vercel.app',
    'https://energy-compliance.vercel.app',
    'https://*.vercel.app'
];

app.use(cors({
    origin: function (origin, callback) {
        // Permitir solicitudes sin origen (como Postman o apps móviles)
        if (!origin) return callback(null, true);
        
        // Verificar si el origen está permitido
        if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
            callback(null, true);
        } else {
            console.log('❌ CORS bloqueado para:', origin);
            callback(new Error('No permitido por CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    exposedHeaders: ['Content-Length', 'X-Requested-With']
}));

// Manejar preflight requests
app.options('*', cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Planes de suscripción
const PLANS = {
  free: {
    name: 'Free',
    max_users: 5,
    max_permits_per_month: 100,
    features: ['firma_basica', 'dashboard_basico', 'soporte_email']
  },
  pro: {
    name: 'Pro',
    max_users: 20,
    max_permits_per_month: 1000,
    features: ['firma_avanzada', 'dashboard_avanzado', 'soporte_prioritario', 'fotos', 'gps', 'offline']
  },
  enterprise: {
    name: 'Enterprise',
    max_users: 999999,
    max_permits_per_month: 999999,
    features: ['firma_avanzada', 'dashboard_personalizado', 'soporte_247', 'fotos', 'gps', 'offline', 'api', 'implementacion_dedicada']
  }
};

async function getMonthlyPermitsCount(companyId) {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const result = await pool.query(
        'SELECT COUNT(*) FROM permits WHERE company_id = $1 AND created_at >= $2',
        [companyId, startOfMonth]
    );
    return parseInt(result.rows[0].count);
}

async function getCompanyUsersCount(companyId) {
    const result = await pool.query(
        'SELECT COUNT(*) FROM users WHERE company_id = $1 AND is_active = true',
        [companyId]
    );
    return parseInt(result.rows[0].count);
}

async function getCompanyAdmin(companyId) {
    const result = await pool.query(
        'SELECT subscription_plan, subscription_expires_at FROM users WHERE company_id = $1 AND role = $2 AND is_active = true',
        [companyId, 'admin']
    );
    return result.rows[0] || null;
}

const authenticate = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No autorizado' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const result = await pool.query(
            'SELECT * FROM users WHERE id = $1 AND is_active = true',
            [decoded.userId]
        );
        if (result.rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });
        req.user = result.rows[0];
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido' });
    }
};

const checkRole = (allowedRoles) => {
    return (req, res, next) => {
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Permiso denegado' });
        }
        next();
    };
};

const checkSubscriptionLimits = async (req, res, next) => {
    const companyAdmin = await getCompanyAdmin(req.user.company_id);
    const plan = PLANS[companyAdmin?.subscription_plan || 'free'];
    if (!plan) return next();
    
    if (req.path === '/users' && req.method === 'POST') {
        const companyUsers = await getCompanyUsersCount(req.user.company_id);
        if (companyUsers >= plan.max_users) {
            return res.status(403).json({ error: `Límite de usuarios alcanzado. Tu plan permite hasta ${plan.max_users} usuarios.` });
        }
    }
    
    if (req.path === '/permits' && req.method === 'POST') {
        const monthlyCount = await getMonthlyPermitsCount(req.user.company_id);
        if (monthlyCount >= plan.max_permits_per_month) {
            return res.status(403).json({ error: `Límite de permisos alcanzado. Has usado ${monthlyCount} de ${plan.max_permits_per_month} este mes.` });
        }
    }
    next();
};

// ============ RUTAS DE AUTENTICACIÓN ============
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1 AND is_active = true',
            [email]
        );
        if (result.rows.length === 0) return res.status(401).json({ error: 'Credenciales inválidas' });
        const user = result.rows[0];
        const isValid = bcrypt.compareSync(password, user.password_hash);
        if (!isValid) return res.status(401).json({ error: 'Credenciales inválidas' });
        
        const companyResult = await pool.query(
            'SELECT name FROM companies WHERE id = $1',
            [user.company_id]
        );
        const companyName = companyResult.rows[0]?.name || '';
        
        const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        res.json({ success: true, token, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, company_id: user.company_id, company_name: companyName, subscription_plan: user.subscription_plan || 'free' } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

app.post('/api/auth/register', async (req, res) => {
    const { company_name, email, password, full_name } = req.body;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Validar que email no sea null
        if (!email) {
            return res.status(400).json({ error: 'El email es requerido' });
        }
        
        // Verificar si ya existe una empresa con ese email
        const existingCompany = await client.query(
            'SELECT id FROM companies WHERE email = $1',
            [email]
        );
        
        if (existingCompany.rows.length > 0) {
            return res.status(400).json({ error: 'La empresa ya está registrada' });
        }
        
        const hash = bcrypt.hashSync(password, 10);
        
        // ✅ CORREGIDO: Insertar email en companies
        const companyResult = await client.query(
            `INSERT INTO companies (name, email, subscription_plan, max_users, max_permits_month, created_at) 
             VALUES ($1, $2, 'free', 5, 100, NOW()) 
             RETURNING id`,
            [company_name, email]
        );
        const companyId = companyResult.rows[0].id;
        
        // Insertar usuario admin
        const userResult = await client.query(
            `INSERT INTO users (company_id, email, password_hash, full_name, role, is_active, created_at) 
             VALUES ($1, $2, $3, $4, 'admin', true, NOW()) 
             RETURNING id, email, full_name, role`,
            [companyId, email, hash, full_name]
        );
        
        await client.query('COMMIT');
        
        const newUser = userResult.rows[0];
        const token = jwt.sign(
            { userId: newUser.id, email: newUser.email, role: newUser.role }, 
            JWT_SECRET, 
            { expiresIn: JWT_EXPIRES_IN }
        );
        
        res.json({ 
            success: true, 
            token, 
            user: { 
                ...newUser, 
                company_name, 
                subscription_plan: 'free' 
            } 
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('DETALLE DEL ERROR:', error.message);
        res.status(500).json({ error: 'Error de base de datos: ' + error.message });
    } finally {
        client.release();
    }
});

// ============ RUTAS DE SUSCRIPCIÓN ============
app.get('/api/subscription/plan', authenticate, async (req, res) => {
    const companyAdmin = await getCompanyAdmin(req.user.company_id);
    const plan = PLANS[companyAdmin?.subscription_plan || 'free'];
    const currentUsers = await getCompanyUsersCount(req.user.company_id);
    const currentMonthPermits = await getMonthlyPermitsCount(req.user.company_id);
    res.json({ success: true, subscription: { plan: companyAdmin?.subscription_plan || 'free', plan_name: plan.name, expires_at: companyAdmin?.subscription_expires_at, max_users: plan.max_users, max_permits_per_month: plan.max_permits_per_month, current_users: currentUsers, current_month_permits: currentMonthPermits, features: plan.features } });
});

app.post('/api/subscription/upgrade', authenticate, checkRole(['admin']), async (req, res) => {
    const { plan } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: 'Plan no válido' });
    
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    
    await pool.query(
        'UPDATE users SET subscription_plan = $1, subscription_expires_at = $2 WHERE id = $3',
        [plan, expiresAt.toISOString(), req.user.id]
    );
    
    res.json({ success: true, message: `Plan actualizado a ${PLANS[plan].name}`, subscription: { plan, plan_name: PLANS[plan].name, expires_at: expiresAt.toISOString() } });
});

// ============ RUTAS DE USUARIOS ============
app.get('/api/users', authenticate, checkRole(['admin']), async (req, res) => {
    const result = await pool.query(
        'SELECT id, email, full_name, role, is_active FROM users WHERE company_id = $1',
        [req.user.company_id]
    );
    res.json({ success: true, users: result.rows });
});

app.post('/api/users', authenticate, checkRole(['admin']), checkSubscriptionLimits, async (req, res) => {
    const { email, password, full_name, role } = req.body;
    try {
        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'El email ya está registrado' });
        }
        
        const hash = bcrypt.hashSync(password, 10);
        const result = await pool.query(
            'INSERT INTO users (company_id, email, password_hash, full_name, role, is_active, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id, email, full_name, role',
            [req.user.company_id, email, hash, full_name, role, true]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al crear usuario' });
    }
});

// ============ RUTAS DE PERMISOS ============
app.post('/api/permits', authenticate, checkSubscriptionLimits, async (req, res) => {
    const { risk_type, safety_checks, technician_name, supervisor_name, work_location, work_description, technician_signature, photos } = req.body;
    const permitNumber = `PTC-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const status = (req.user.role === 'admin' || req.user.role === 'supervisor') ? 'APPROVED' : 'PENDING';
    
    const result = await pool.query(
        `INSERT INTO permits (permit_number, risk_type, safety_checks, technician_name, supervisor_name, 
         work_location, work_description, status, technician_signature, photos, photos_count, 
         created_at, created_by, created_by_name, created_by_role, company_id, 
         approved_at, approved_by, approved_by_name) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12, $13, $14, $15, 
         $16, $17, $18) RETURNING *`,
        [permitNumber, risk_type, safety_checks, technician_name, supervisor_name, work_location, 
         work_description, status, technician_signature, photos, (photos || []).length,
         req.user.id, req.user.full_name, req.user.role, req.user.company_id,
         status === 'APPROVED' ? new Date().toISOString() : null,
         status === 'APPROVED' ? req.user.id : null,
         status === 'APPROVED' ? req.user.full_name : null]
    );
    
    const newPermit = result.rows[0];
    const pdfBuffer = Buffer.from(`%PDF-1.4 placeholder for ${permitNumber}`);
    
    res.json({ success: true, permit: newPermit, safetyEvaluation: { isSafe: true }, pdf: pdfBuffer.toString('base64'), requiresApproval: req.user.role === 'technician' });
});

app.get('/api/permits', authenticate, async (req, res) => {
    let query;
    let params;
    
    if (req.user.role === 'technician') {
        query = 'SELECT * FROM permits WHERE created_by = $1 ORDER BY created_at DESC';
        params = [req.user.id];
    } else {
        query = 'SELECT * FROM permits WHERE company_id = $1 ORDER BY created_at DESC';
        params = [req.user.company_id];
    }
    
    const result = await pool.query(query, params);
    res.json({ success: true, permits: result.rows });
});

app.put('/api/permits/:permitId/approve', authenticate, checkRole(['admin', 'supervisor']), async (req, res) => {
    const { permitId } = req.params;
    const { action, supervisor_signature, rejection_reason } = req.body;
    
    const permitResult = await pool.query(
        'SELECT * FROM permits WHERE id = $1 AND company_id = $2',
        [parseInt(permitId), req.user.company_id]
    );
    
    if (permitResult.rows.length === 0) {
        return res.status(404).json({ error: 'Permiso no encontrado' });
    }
    
    const permit = permitResult.rows[0];
    if (permit.status !== 'PENDING') {
        return res.status(400).json({ error: 'Ya fue procesado' });
    }
    
    if (action === 'approve') {
        const result = await pool.query(
            `UPDATE permits SET status = 'APPROVED', approved_by = $1, approved_by_name = $2, 
             approved_at = NOW(), supervisor_signature = $3 WHERE id = $4 RETURNING *`,
            [req.user.id, req.user.full_name, supervisor_signature, parseInt(permitId)]
        );
        return res.json({ success: true, permit: result.rows[0] });
    } else if (action === 'reject') {
        const result = await pool.query(
            `UPDATE permits SET status = 'REJECTED', rejected_by = $1, rejected_by_name = $2, 
             rejected_at = NOW(), rejection_reason = $3 WHERE id = $4 RETURNING *`,
            [req.user.id, req.user.full_name, rejection_reason || 'Sin especificar', parseInt(permitId)]
        );
        return res.json({ success: true, permit: result.rows[0] });
    }
    res.status(400).json({ error: 'Acción inválida' });
});

app.get('/api/dashboard/stats', authenticate, async (req, res) => {
    let query;
    let params;
    
    if (req.user.role === 'technician') {
        query = 'SELECT * FROM permits WHERE created_by = $1';
        params = [req.user.id];
    } else {
        query = 'SELECT * FROM permits WHERE company_id = $1';
        params = [req.user.company_id];
    }
    
    const result = await pool.query(query, params);
    const permits = result.rows;
    
    res.json({ success: true, data: { 
        total_permits: permits.length, 
        approved_permits: permits.filter(p => p.status === 'APPROVED').length, 
        rejected_permits: permits.filter(p => p.status === 'REJECTED').length, 
        pending_permits: permits.filter(p => p.status === 'PENDING').length 
    } });
});

app.get('/api/health', async (req, res) => {
    try {
        const result = await pool.query('SELECT COUNT(*) FROM permits');
        res.json({ status: 'OK', message: 'Energy-Compliance API running', permits: parseInt(result.rows[0].count) });
    } catch (error) {
        res.json({ status: 'OK', message: 'Energy-Compliance API running - DB error', error: error.message });
    }
});

// ✅ CRÍTICO PARA VERCEL: Exportar app en lugar de llamar app.listen()
module.exports = app;

const PORT = process.env.PORT || 3001;

// Escuchamos en 0.0.0.0 para que Railway pueda redirigir el tráfico
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor de Petrolinkvzla activo en el puerto ${PORT}`);
    if (process.env.NODE_ENV !== 'production') {
        console.log(`🔗 Local: http://localhost:${PORT}`);
    }
});
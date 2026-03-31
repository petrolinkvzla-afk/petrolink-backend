// server/src/controllers/photoController.js
const cloudinary = require('cloudinary').v2;
const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// Configurar Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

class PhotoController {
    async uploadPhoto(req, res) {
        const client = await pool.connect();
        
        try {
            const { permitId, metadata } = req.body;
            const photoBase64 = req.body.photo;
            
            // Validar que el permiso existe
            const permitCheck = await client.query(
                'SELECT id FROM permits WHERE id = $1',
                [permitId]
            );
            
            if (permitCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Permiso no encontrado' });
            }
            
            // Subir a Cloudinary
            const uploadResult = await cloudinary.uploader.upload(photoBase64, {
                folder: `energy-compliance/permits/${permitId}`,
                public_id: uuidv4(),
                resource_type: 'image',
                transformation: [
                    { quality: 'auto:good' },
                    { fetch_format: 'auto' }
                ]
            });
            
            // Guardar metadata en base de datos
            const result = await client.query(
                `INSERT INTO photo_evidence 
                 (permit_id, cloudinary_url, public_id, metadata, uploaded_at)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING *`,
                [
                    permitId,
                    uploadResult.secure_url,
                    uploadResult.public_id,
                    JSON.stringify(JSON.parse(metadata || '{}')),
                    new Date()
                ]
            );
            
            res.json({
                success: true,
                photo: {
                    id: result.rows[0].id,
                    url: uploadResult.secure_url,
                    publicId: uploadResult.public_id,
                    metadata: result.rows[0].metadata
                }
            });
            
        } catch (error) {
            console.error('Error uploading photo:', error);
            res.status(500).json({ error: error.message });
        } finally {
            client.release();
        }
    }
    
    async getPermitPhotos(req, res) {
        const { permitId } = req.params;
        
        try {
            const result = await pool.query(
                `SELECT * FROM photo_evidence 
                 WHERE permit_id = $1 
                 ORDER BY uploaded_at DESC`,
                [permitId]
            );
            
            res.json({
                success: true,
                photos: result.rows
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
}

module.exports = new PhotoController();
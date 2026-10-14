# MyAI Final

MyAI adalah aplikasi chat pribadi dengan OpenRouter, AI/ML API, dan LLM7 yang sudah terhubung otomatis melalui backend lokal. Pengguna tidak perlu memasukkan API key di Pengaturan.

## Menjalankan

1. Pastikan Node.js 20 atau lebih baru sudah terpasang.
2. Buka terminal di folder `app`.
3. Jalankan `npm start`.
4. Buka alamat yang tampil di terminal, secara default `http://127.0.0.1:8080`.

Jangan membuka `index.html` langsung dan jangan memakai server statis biasa, karena koneksi AI memerlukan `server.mjs`.

## Lampiran

- Tombol `+` menampilkan menu ringkas untuk memilih file atau folder.
- Semua format dapat dipilih. Dokumen teks, kode, PDF, DOCX, XLSX, PPTX, ZIP, dan gambar dibaca sesuai formatnya; file biner lain tetap dapat dilampirkan sebagai metadata.
- Klik kartu lampiran sebelum atau sesudah dikirim untuk membuka pratinjau selama tab masih aktif.
- Maksimal 8 MB per file, 100 file atau 25 MB per pilihan.
- Folder dependensi, file tersembunyi tertentu, `.env`, private key, dan file kredensial dilewati otomatis.

## API dan keamanan

- Kunci provider berada di `.env` dan tidak pernah dikirim ke browser.
- `.env` sudah masuk `.gitignore`; jangan unggah file ini ke repository atau membagikannya.
- Untuk mengganti kunci, ubah `.env` di server lalu mulai ulang aplikasi.
- Backend hanya mengizinkan provider yang sudah ditentukan, sehingga pengguna tidak dapat memasukkan alamat API arbitrer.
- Jika aplikasi dipindah ke hosting publik, gunakan server Node yang mendukung environment secrets. Hosting statis seperti GitHub Pages tidak dapat menyimpan kunci dengan aman.

## File utama

- `server.mjs`: server web dan proxy API aman.
- `.env`: kunci provider lokal.
- `index.html`: struktur antarmuka.
- `css/style.css`: desain antarmuka.
- `js/app.js`: chat, unggah, dan pratinjau lampiran.
- `js/providers.js`: katalog model dan streaming AI.
- `js/db.js`: login serta penyimpanan riwayat.

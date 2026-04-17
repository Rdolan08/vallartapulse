# Deployment

## Production architecture
- Frontend: Vercel
- Backend API: Railway
- Database: Railway Postgres
- Source of truth: GitHub

## Notes
- Production frontend is now served from Vercel.
- Production backend/API is now served from Railway.
- Keep infra changes separate from feature recovery work.
- Treat the current production state as the new stable baseline.

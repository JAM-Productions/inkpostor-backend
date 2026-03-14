import { server } from './index';

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
    console.log(`Socket.IO Server running on port ${PORT}`);
});

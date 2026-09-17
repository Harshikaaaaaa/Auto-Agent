/** Barrel file — importing this ensures all connectors self-register */

// External services (need a credential)
import './gmail';
import './googleSheets';
import './googleDrive';
import './slack';
import './whatsapp';

// Built-in capabilities (no credential required)
import './web';
import './content';
import './files';

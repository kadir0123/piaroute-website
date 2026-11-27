#!/bin/bash
sudo -u postgres psql -d piaroute -v ON_ERROR_STOP=1 -c "DELETE FROM reports WHERE id IN ('43142e7a-a7a7-43c9-a8e6-5d01f9be09f0','89c97fbd-057f-4a70-ae63-eb77f13ddea4');"
rm -f /var/lib/piaroute/photos/43142e7a-a7a7-43c9-a8e6-5d01f9be09f0.jpg
echo removed

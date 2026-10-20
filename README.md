# [`fastgis.cc`](https://fastgis.cc)

Drop trajectory or link-ID CSV files onto the map to import them. Files are
processed one at a time, and a failed file does not prevent other files in the
batch from loading.

Routes are saved locally in IndexedDB, with only a small tab identifier kept in
sessionStorage. Existing sessionStorage routes are migrated after a successful
database write. Reloading the same tab restores its routes and camera; map
movement saves only the camera, not another copy of every trajectory.

There is no fixed trajectory-count limit. Capacity depends on browser storage,
available memory, and the total number of points rendered. If browser storage
is full or unavailable, the map keeps working and displays a warning; download
important routes before reloading or closing the tab. IndexedDB data remains
on the device until removed by the browser or by clearing site data.

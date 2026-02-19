use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

pub const MAX_MERCATOR_LAT: f64 = 85.051_128_78;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub min_lat: f64,
    pub min_lon: f64,
    pub max_lat: f64,
    pub max_lon: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrajectoryPoint {
    pub time: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CsvParseResult {
    pub points: Vec<TrajectoryPoint>,
    pub valid_rows: usize,
    pub invalid_rows: usize,
}

pub fn clamp_lat(lat: f64) -> f64 {
    lat.clamp(-MAX_MERCATOR_LAT, MAX_MERCATOR_LAT)
}

pub fn normalize_lon(lon: f64) -> f64 {
    let wrapped = (lon + 180.0).rem_euclid(360.0) - 180.0;
    if wrapped == -180.0 {
        180.0
    } else {
        wrapped
    }
}

pub fn lon_lat_to_world(lon: f64, lat: f64, zoom: u8, tile_size: u32) -> (f64, f64) {
    let lat = clamp_lat(lat);
    let scale = f64::from(tile_size) * 2.0_f64.powi(i32::from(zoom));
    let x = (normalize_lon(lon) + 180.0) / 360.0 * scale;

    let lat_rad = lat.to_radians();
    let y = (1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / PI) / 2.0 * scale;
    (x, y)
}

pub fn world_to_lon_lat(x: f64, y: f64, zoom: u8, tile_size: u32) -> (f64, f64) {
    let scale = f64::from(tile_size) * 2.0_f64.powi(i32::from(zoom));
    let lon = normalize_lon(x / scale * 360.0 - 180.0);
    let n = PI - (2.0 * PI * y) / scale;
    let lat = n.sinh().atan().to_degrees();
    (lon, clamp_lat(lat))
}

pub fn parse_trajectory_csv(input: &str) -> CsvParseResult {
    let mut rows: Vec<&str> = input
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();

    if rows.is_empty() {
        return CsvParseResult {
            points: Vec::new(),
            valid_rows: 0,
            invalid_rows: 0,
        };
    }

    let mut time_idx = 0usize;
    let mut lat_idx = 1usize;
    let mut lon_idx = 2usize;

    let first_parts: Vec<&str> = rows[0].split(';').map(str::trim).collect();
    if first_parts.len() >= 3 {
        let lower: Vec<String> = first_parts.iter().map(|v| v.to_ascii_lowercase()).collect();
        let has_named_columns = lower.contains(&"time".to_string())
            && lower.contains(&"lat".to_string())
            && lower.contains(&"lon".to_string());

        if has_named_columns {
            for (idx, name) in lower.iter().enumerate() {
                match name.as_str() {
                    "time" => time_idx = idx,
                    "lat" => lat_idx = idx,
                    "lon" => lon_idx = idx,
                    _ => {}
                }
            }
            rows.remove(0);
        }
    }

    let mut points = Vec::with_capacity(rows.len());
    let mut valid_rows = 0usize;
    let mut invalid_rows = 0usize;

    for row in rows {
        let parts: Vec<&str> = row.split(';').map(str::trim).collect();
        if parts.len() <= time_idx || parts.len() <= lat_idx || parts.len() <= lon_idx {
            invalid_rows += 1;
            continue;
        }

        let time = parts[time_idx].to_string();
        let lat = parts[lat_idx].parse::<f64>();
        let lon = parts[lon_idx].parse::<f64>();

        match (lat, lon) {
            (Ok(lat), Ok(lon))
                if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon) =>
            {
                points.push(TrajectoryPoint { time, lat, lon });
                valid_rows += 1;
            }
            _ => invalid_rows += 1,
        }
    }

    CsvParseResult {
        points,
        valid_rows,
        invalid_rows,
    }
}

pub fn trajectory_bounds(points: &[TrajectoryPoint]) -> Option<Bounds> {
    if points.is_empty() {
        return None;
    }

    let mut min_lat = points[0].lat;
    let mut max_lat = points[0].lat;
    let mut min_lon = points[0].lon;
    let mut max_lon = points[0].lon;

    for point in points.iter().skip(1) {
        min_lat = min_lat.min(point.lat);
        max_lat = max_lat.max(point.lat);
        min_lon = min_lon.min(point.lon);
        max_lon = max_lon.max(point.lon);
    }

    Some(Bounds {
        min_lat,
        min_lon,
        max_lat,
        max_lon,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mercator_roundtrip_is_stable() {
        let coords = [
            (13.4050, 52.52),
            (-73.935242, 40.73061),
            (151.2093, -33.8688),
        ];
        let zoom = 7u8;

        for (lon, lat) in coords {
            let (x, y) = lon_lat_to_world(lon, lat, zoom, 256);
            let (lon_back, lat_back) = world_to_lon_lat(x, y, zoom, 256);
            assert!((lon - lon_back).abs() < 0.0001);
            assert!((lat - lat_back).abs() < 0.0001);
        }
    }

    #[test]
    fn parse_semicolon_csv_with_header() {
        let csv = "TIME;LAT;LON\n2026-01-01T10:00:00Z;52.5;13.4\n2026-01-01T10:01:00Z;52.6;13.5";
        let parsed = parse_trajectory_csv(csv);
        assert_eq!(parsed.valid_rows, 2);
        assert_eq!(parsed.invalid_rows, 0);
        assert_eq!(parsed.points.len(), 2);
        assert_eq!(parsed.points[0].time, "2026-01-01T10:00:00Z");
    }

    #[test]
    fn parse_semicolon_csv_without_header() {
        let csv = "2026-01-01T10:00:00Z;52.5;13.4\n2026-01-01T10:01:00Z;52.6;13.5";
        let parsed = parse_trajectory_csv(csv);
        assert_eq!(parsed.valid_rows, 2);
        assert_eq!(parsed.invalid_rows, 0);
    }

    #[test]
    fn parse_counts_invalid_rows() {
        let csv = "TIME;LAT;LON\n2026-01-01T10:00:00Z;BAD;13.4\n2026-01-01T10:01:00Z;91;13.5\n2026-01-01T10:02:00Z;52.6;13.6";
        let parsed = parse_trajectory_csv(csv);
        assert_eq!(parsed.valid_rows, 1);
        assert_eq!(parsed.invalid_rows, 2);
    }

    #[test]
    fn computes_bounds() {
        let points = vec![
            TrajectoryPoint {
                time: "a".to_string(),
                lat: 52.5,
                lon: 13.4,
            },
            TrajectoryPoint {
                time: "b".to_string(),
                lat: 52.6,
                lon: 13.1,
            },
            TrajectoryPoint {
                time: "c".to_string(),
                lat: 52.4,
                lon: 13.7,
            },
        ];

        let bounds = trajectory_bounds(&points).expect("bounds");
        assert_eq!(bounds.min_lat, 52.4);
        assert_eq!(bounds.max_lat, 52.6);
        assert_eq!(bounds.min_lon, 13.1);
        assert_eq!(bounds.max_lon, 13.7);
    }
}

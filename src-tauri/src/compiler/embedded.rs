use std::path::Path;
use tectonic_bundles::Bundle;
use tectonic_io_base::{
    digest::DigestData, InputHandle, InputOrigin, IoProvider, OpenResult, OutputHandle,
};
use tectonic_status_base::StatusBackend;

const SIMPLEICONS_STY: &[u8] = include_bytes!("../../embedded_packages/simpleicons/simpleicons.sty");
const SIMPLEICONS_GLYPHS: &[u8] = include_bytes!("../../embedded_packages/simpleicons/simpleiconsglyphs-xeluatex.tex");
const SIMPLEICONS_OTF: &[u8] = include_bytes!("../../embedded_packages/simpleicons/SimpleIcons.otf");
pub const SAMPLE_PNG: &[u8] = include_bytes!("../../embedded_packages/assets/sample.png");
pub const SAMPLE_GIF: &[u8] = include_bytes!("../../embedded_packages/assets/sample.gif");
pub const SAMPLE_BIB: &[u8] = br#"@article{einstein1905,
  author = {Albert Einstein},
  title = {Zur Elektrodynamik bewegter K{\"o}rper},
  journal = {Annalen der Physik},
  volume = {322},
  number = {10},
  pages = {891--921},
  year = {1905},
  publisher = {Wiley Online Library}
}
"#;

pub fn get_embedded_package_file(name: &str) -> Option<&'static [u8]> {
    let clean = Path::new(name)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(name);

    if clean.eq_ignore_ascii_case("simpleicons.sty") {
        Some(SIMPLEICONS_STY)
    } else if clean.eq_ignore_ascii_case("simpleiconsglyphs-xeluatex.tex") {
        Some(SIMPLEICONS_GLYPHS)
    } else if clean.eq_ignore_ascii_case("SimpleIcons.otf")
        || clean.eq_ignore_ascii_case("simpleicons.otf")
        || clean.eq_ignore_ascii_case("SimpleIcons")
        || clean.eq_ignore_ascii_case("simpleicons")
    {
        Some(SIMPLEICONS_OTF)
    } else if clean.eq_ignore_ascii_case("sample.png") {
        Some(SAMPLE_PNG)
    } else if clean.eq_ignore_ascii_case("sample.gif") {
        Some(SAMPLE_GIF)
    } else if clean.eq_ignore_ascii_case("references.bib") || clean.eq_ignore_ascii_case("references") {
        Some(SAMPLE_BIB)
    } else {
        None
    }
}

pub struct EmbeddedPackageBundle {
    pub inner: Box<dyn Bundle>,
}

impl IoProvider for EmbeddedPackageBundle {
    fn output_open_name(&mut self, name: &str) -> OpenResult<OutputHandle> {
        self.inner.output_open_name(name)
    }

    fn output_open_stdout(&mut self) -> OpenResult<OutputHandle> {
        self.inner.output_open_stdout()
    }

    fn input_open_name(
        &mut self,
        name: &str,
        status: &mut dyn StatusBackend,
    ) -> OpenResult<InputHandle> {
        if let Some(bytes) = get_embedded_package_file(name) {
            return OpenResult::Ok(InputHandle::new(
                name,
                std::io::Cursor::new(bytes.to_vec()),
                InputOrigin::Other,
            ));
        }
        self.inner.input_open_name(name, status)
    }

    fn input_open_name_with_abspath(
        &mut self,
        name: &str,
        status: &mut dyn StatusBackend,
    ) -> OpenResult<(InputHandle, Option<std::path::PathBuf>)> {
        if let Some(bytes) = get_embedded_package_file(name) {
            return OpenResult::Ok((
                InputHandle::new(
                    name,
                    std::io::Cursor::new(bytes.to_vec()),
                    InputOrigin::Other,
                ),
                None,
            ));
        }
        self.inner.input_open_name_with_abspath(name, status)
    }

    fn input_open_primary(&mut self, status: &mut dyn StatusBackend) -> OpenResult<InputHandle> {
        self.inner.input_open_primary(status)
    }

    fn input_open_primary_with_abspath(
        &mut self,
        status: &mut dyn StatusBackend,
    ) -> OpenResult<(InputHandle, Option<std::path::PathBuf>)> {
        self.inner.input_open_primary_with_abspath(status)
    }

    fn input_open_format(
        &mut self,
        name: &str,
        status: &mut dyn StatusBackend,
    ) -> OpenResult<InputHandle> {
        self.inner.input_open_format(name, status)
    }

    fn write_format(
        &mut self,
        name: &str,
        data: &[u8],
        status: &mut dyn StatusBackend,
    ) -> tectonic_errors::Result<()> {
        self.inner.write_format(name, data, status)
    }
}

impl Bundle for EmbeddedPackageBundle {
    fn get_digest(&mut self) -> tectonic_errors::Result<DigestData> {
        self.inner.get_digest()
    }

    fn all_files(&self) -> Vec<String> {
        let mut files = self.inner.all_files();
        files.push("simpleicons.sty".to_string());
        files.push("simpleiconsglyphs-xeluatex.tex".to_string());
        files.push("SimpleIcons.otf".to_string());
        files
    }
}

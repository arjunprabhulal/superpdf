from langchain_superpdf import __all__

EXPECTED_ALL = [
    "SuperPDFLoader",
    "SuperPDFParser",
    "__version__",
]


def test_all_imports() -> None:
    assert sorted(EXPECTED_ALL) == sorted(__all__)

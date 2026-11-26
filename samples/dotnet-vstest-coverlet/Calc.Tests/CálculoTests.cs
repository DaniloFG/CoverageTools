using Xunit;

namespace Calc.Tests.Más;

// Non-ASCII namespace and class names: a partial run of this file must select exactly this class.
public class CálculoTests
{
    [Fact]
    public void SumaDosNúmeros()
    {
        Assert.Equal(4, Calculator.Add(2, 2));
    }
}
